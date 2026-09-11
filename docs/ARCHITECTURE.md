# Architektur

## Source of truth

GitHub-Repo `Codeelchi/rheinagent-file-upload`, Branch `main`. Entwicklung
ausschließlich hier; Distribution läuft über die zentrale Pipeline
(siehe [VERSIONING.md](VERSIONING.md)), nicht über dieses Repo direkt.

## MCP-SDK

Seit 2026-09-11 echte Protokoll-`2026-07-28`-Konformität: `@modelcontextprotocol/server`
+ `@modelcontextprotocol/node` (v2-Paketlinie, nicht mehr das ältere
`@modelcontextprotocol/sdk`, dessen `SUPPORTED_PROTOCOL_VERSIONS` nur bis
`2025-11-25` reichte). `createMcpHandler()` + `toNodeHandler()` bedienen
**beide Epochen** über einen einzigen Endpunkt: alte `initialize`-Handshakes
(2025-06-18 o.ä., Legacy-Shim) laufen weiterhin unverändert, während echte
`2026-07-28`-Clients das stateless Pro-Request-`_meta`-Modell nutzen (kein
Session-Handshake, jeder Request trägt `io.modelcontextprotocol/protocolVersion`
+ `clientCapabilities` selbst). Jeder Tool deklariert jetzt `outputSchema`
(zod, automatisch zu JSON Schema konvertiert) und `annotations`
(`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`).

**Für HTTP-Clients wichtig:** Streamable-HTTP-Requests im modernen Modus
brauchen zusätzlich die Header `Mcp-Method` (= `params.method`) und bei
`tools/call` `Mcp-Name` (= `params.name`) — eine SEP-2243-Validierung gegen
Smuggling. Fehlen sie, kommt `-32020 HeaderMismatch` zurück, keine stille
Fehlfunktion.

## Runtime-Layer

```text
┌─────────────────────────┐       ┌──────────────────────────┐
│  Control Plane           │       │  Data Plane               │
│  server.ts (Port 3901)   │       │  dataplane.ts (Port 3902) │
│  MCP JSON-RPC (/mcp)     │       │  rohe Bytes (PUT/GET)      │
│  18 öffentliche Tools    │       │  keine MCP-Tools, kein     │
│  Business-/Sicherheits-  │       │  Audit, keine Business-    │
│  logik, Audit-Aufrufe    │       │  logik — Staging-Write,    │
│                           │       │  Download-Read, /healthz  │
└────────────┬─────────────┘       └────────────┬──────────────┘
             │                                   │
             └──────────────┬────────────────────┘
                             ▼
                    data/ (gemeinsames Dateisystem)
                    staging/  files/  results/  meta/state.sqlite
```

Beide Prozesse sind **getrennt**, weil große Binärdaten nie durch MCP-JSON
laufen sollen: der Control-Plane-Prozess kennt nur `upload_id`/`file_id`/
`job_id`, nie rohe Bytes im Request/Response-Pfad (außer dem Sonderfall
kleiner Text-Inhalte in `rheinagent_file_get`, siehe unten). Beide Prozesse
teilen sich ausschließlich das Dateisystem unter `data/`, nicht den
Prozessspeicher — Metadaten liegen seit 2026-09-11 in einer gemeinsamen
SQLite-Datenbank (`data/meta/state.sqlite`, WAL-Modus, `src/lib/sqliteIndex.ts`),
vorher in einzelnen JSON-Dateien. Jeder Tabellenzugriff geht direkt gegen
diese Datei, kein In-Memory-Cache in keinem der beiden Prozesse — siehe
[STATE-MIGRATION.md](STATE-MIGRATION.md) für die Migrationsbegründung.

Beide Prozesse binden standardmäßig ausschließlich an `127.0.0.1`
(`RHEINAGENT_FILE_UPLOAD_BIND_HOST`, Default `127.0.0.1`) — da diese Version
keinerlei TLS/Auth auf HTTP-Ebene hat (siehe [SECURITY.md](SECURITY.md)),
würde ein Default von `0.0.0.0` das Produkt sonst ungeschützt im
LAN/Tailnet erreichbar machen. Ein Betrieb hinter einem Reverse Proxy oder
mit anderer Zugriffskontrolle kann den Host explizit überschreiben.

## Identität/Autorisierung

Diese erste Version hat **keine eigene Nutzer-/Mandantentrennung** — alle
MCP-Clients, die den Control-Plane-Endpunkt erreichen, teilen sich denselben
Datei-/Job-Namespace. Das ist eine bewusste v1-Einschränkung für
Einzelbetrieb, siehe [SECURITY.md](SECURITY.md) und [HANDOFF.md](HANDOFF.md).

## Read / Prepare / Apply / Verify

Jede zustandsverändernde Operation folgt demselben Muster statt einer
einzelnen "mach es einfach"-Aktion:

| Bereich | Prepare | Apply/Verify |
|---|---|---|
| Upload | `rheinagent_file_upload_prepare` legt einen befristeten Staging-Platz an (15 min TTL) | `rheinagent_file_upload_finalize` validiert (Größe/Magic-Bytes/Extension/Hash) und verschiebt atomar nach `files/` |
| Verarbeitung | `rheinagent_file_process_prepare` legt einen Job an, führt **nichts aus** | `rheinagent_file_process_apply` führt den registrierten Processor aus und schreibt das Ergebnis atomar (temp-write + rename) |
| Löschung | `rheinagent_file_delete_prepare` markiert `pendingDelete`, Datei bleibt vorerst liegen | `rheinagent_file_delete_apply` entfernt die Datei, ihren `FileRecord` **und** kaskadierend jeden zugehörigen `JobRecord`+Ergebnis endgültig anhand des `delete_token` (seit 2026-09-11, siehe [SECURITY.md](SECURITY.md)) |

Ein Prepare-Schritt ist jederzeit folgenlos verwerfbar (TTL-Ablauf bzw.
schlicht nicht-Apply). Erst der Apply-Schritt ist die tatsächliche,
auditierte kritische Mutation (siehe [AUDIT.md](AUDIT.md)).

## Staging / Quarantine

Hochgeladene Bytes landen zunächst unter `data/staging/<upload_id>` — einem
rein opaken, vom Client nicht wählbaren Pfad. Erst `upload_finalize` liest
diese Datei, prüft sie server-seitig (siehe [SECURITY.md](SECURITY.md)) und
verschiebt sie per `fs.rename` (atomar auf demselben Volume) nach
`data/files/<file_id>`. Schlägt die Prüfung fehl, wird die Staging-Datei
gelöscht und die Quarantine verlassen nie — es gibt keinen Pfad, auf dem
ungeprüfte Bytes in `files/` ankommen.

Ein PUT ohne folgendes `upload_finalize` (oder gar kein PUT nach
`upload_prepare`) lässt eine Staging-Datei verwaist zurück — die 15-Minuten-
TTL löscht ohne aktives Zutun nur den Metadaten-Eintrag, nie die Bytes
selbst. `sweepOrphanedStaging()` (`src/lib/store.ts`) räumt das auf: einmal
beim Start der Control Plane und danach alle 15 Minuten
(`STAGING_SWEEP_INTERVAL_MS` in `server.ts`), unref'd, damit der Timer den
Prozess nicht künstlich am Leben hält. Details: [SECURITY.md](SECURITY.md).

## Download

Für alles, was nicht als kleine Textdatei inline über `rheinagent_file_get`
geht (große Dateien, PDFs, Bilder), gilt derselbe Trennungsgrundsatz wie
beim Upload: Bytes laufen nie durch MCP-JSON. `rheinagent_file_download_prepare`
prüft, dass die Datei existiert und nicht `pendingDelete` ist, und legt ein
befristetes (15 min), wiederverwendbares `download_token` an (`data/meta/downloads.json`,
Muster analog zu `PendingUpload`). Die Data Plane bedient `GET
/download/:downloadToken`, löst das Token gegen `fileId` auf, liest die
Datei ausschließlich über `filePath()` (also nur opake, bereits validierte
Pfade unter `data/files/`) und streamt sie mit `Content-Disposition:
attachment`. Ein Token ist im Gegensatz zum `delete_token` bewusst nicht
Einweg — ein `GET` ist laut `readOnlyHint`-Konvention idempotent, ein
erneuter Abruf mit demselben Token innerhalb der TTL muss also funktionieren.
Läuft das Token ab oder wird die Datei zwischenzeitlich gelöscht, liefert
die Data Plane `404` bzw. `410`.

## Health / Doctor

`rheinagent_file_health_get` implementiert das in
[VERSIONING.md](VERSIONING.md) beschriebene Health/Doctor-Konzept
(Health-Profil `rheinagent-file-upload-v1`): `control_plane_reachable` ist
per Definition `true` (das Tool antwortet gerade), `data_plane_reachable`
prüft `GET /healthz` auf der Data Plane (2 s Timeout), `staging_dir_writable`/
`files_dir_writable` prüfen per `fs.access(dir, W_OK)` ohne eine Probe-Datei
zu hinterlassen. `storage` (`file_count`, `total_bytes`,
`staging_file_count`, aus `getStorageStats()` in `store.ts`) gibt einem
Client den aktuellen Verbrauch, ohne dafür `rheinagent_file_list`
komplett durchpaginieren zu müssen — `file_count`/`total_bytes` zählen
auch gerade `pendingDelete`-Dateien mit, deren Bytes bis zum tatsächlichen
`delete_apply` noch belegt sind. `storage.by_mime_category` (seit
2026-09-11) schlüsselt Anzahl/Bytes zusätzlich pro `mime_category` auf —
ein **partielles** Objekt (`z.partialRecord`, nicht `z.record`): nur
Kategorien mit mindestens einer Datei tauchen als Key auf, eine Instanz
ohne Archiv-Uploads hat also nie einen `archive`-Key. Im `hub`-Audit-Modus
meldet das Tool
zusätzlich, **ob**
`RA_AUDIT_ENDPOINT`/`RA_AUDIT_SERVICE_ID`/`RA_AUDIT_CREDENTIAL_PATH` gesetzt
sind (nie die Werte selbst) sowie `hub_endpoint_reachable` — ein bewusst
protokoll-loser Best-Effort-Netzwerk-Check (`checkHubEndpointReachable()`
in `src/lib/audit.ts`, siehe Kommentar dort), **kein** Beweis, dass der
Write-Ahead-Vertrag selbst funktioniert (der bleibt implementiert, aber
unverifiziert, siehe [HANDOFF.md](HANDOFF.md)). `status` ist `"degraded"`,
sobald irgendeine dieser Prüfungen negativ ausfällt.

## Processor-Registry

`src/lib/processors.ts` enthält eine feste `Map<string, ProcessorEntry>`. Ein
Processor ist eine zur Build-Zeit registrierte TypeScript-Funktion, die eine
lokale Datei liest und ein JSON-Ergebnis zurückgibt — kein Shell-Aufruf, kein
`eval`, keine vom Client mitgelieferte Logik. Neue Fähigkeiten bedeuten einen
neuen Registry-Eintrag plus Release, nie eine Laufzeit-Erweiterung durch ein
MCP-Tool. Jeder Eintrag deklariert außerdem seine
`supportedMimeCategories` — `rheinagent_file_process_prepare` prüft das
**vor** dem Anlegen eines Jobs (`processorSupportsMimeCategory()`), sodass
eine falsche Kombination (z. B. `text_stats` gegen eine PDF) sofort mit
einer klaren Fehlermeldung abgelehnt wird, statt erst nach einem echten
`process_apply`-Versuch mit `state: "failed"` zu enden. Der
Laufzeit-Check pro Processor-Funktion bleibt zusätzlich als Verteidigung
in der Tiefe bestehen.

Aktuell registriert (volle Optionsreferenz: [PROCESSORS.md](PROCESSORS.md)):

| Processor | `mime_category` | Ergebnis |
|---|---|---|
| `text_stats` | text | `line_count`, `word_count`, `char_count` |
| `text_uppercase` | text | `transformed_text` (kompletter Inhalt, Großbuchstaben) |
| `text_extract` | text | `text` (bis 64 KiB), `char_count`, `word_count`, `line_count`, `truncated` |
| `markdown_structure` | text (nur `.md`) | `headings`, `links_count`, `code_block_count` |
| `csv_inspect` | text (nur `.csv`) | `delimiter`, `row_count`, `column_count`, `headers`, `sample_rows`, `truncated` |
| `json_inspect` | text (nur `.json`) | `root_type`, `array_length`, `keys`, `keys_truncated`, `sample`, `sample_truncated` |
| `image_metadata` | image | `format` (`png`/`jpeg`), `width`, `height`, `size_bytes` — Dimensionen per Hand aus PNG-IHDR bzw. JPEG-SOF-Markern geparst, **keine** Bildbibliothek (kein `sharp`/`jimp`: nativ bzw. für reines Header-Lesen unnötig) |
| `pdf_metadata` | pdf | `page_count`, `pdf_format_version`, `title`, `author` (letztere `null`, falls nicht gesetzt) |
| `pdf_extract_text` | pdf | `extracted_text` (auf 64 KiB gekappt, wie `INLINE_CONTENT_MAX_BYTES` an anderer Stelle — Ergebnis fließt über `result_get` durch MCP-JSON zurück), `page_count`, `page` (`null` = ganzes Dokument, sonst 1-indexierte Seitenzahl), `truncated` |
| `docx_extract_text` | office (nur `.docx`) | `text` (bis 64 KiB), `paragraph_count`, `table_count`, `truncated` |
| `xlsx_inspect` | office (nur `.xlsx`) | `sheet_names`, `sheet`, `row_count`, `column_count`, `headers`, `sample_rows`, `shared_strings_truncated`, `truncated` |

`text` deckt vier Extensions ab (`.txt`/`.md`/`.csv`/`.json`) — `csv_inspect`,
`json_inspect` und `markdown_structure` prüfen deshalb zusätzlich zur groben
`mime_category` noch die konkrete Dateiendung selbst (`requireExtension()`),
ebenso `docx_extract_text`/`xlsx_inspect` innerhalb von `office`
(`.docx`/`.xlsx`). `docx`/`xlsx` sind intern ZIP-Container — siehe
[SECURITY.md](SECURITY.md) für den bounded-Unzip-Ansatz
(`src/lib/officeZip.ts`/`src/lib/officeXml.ts`), der das strukturell vom
generellen Archive-Bomb-Ausschluss trennt.

`pdf_metadata`/`pdf_extract_text` nutzen `pdfjs-dist` (Mozillas eigener
PDF.js-Kern) — bewusst **nicht** das populärere `pdf-parse`, das
`@napi-rs/canvas` (natives Rust-Addon) als Hard-Dependency zieht, unnötig
für reine Textextraktion und auf einem arm64-Pi unerwünscht. `pdfjs-dist`
selbst hat null Laufzeit-Abhängigkeiten. Läuft ohne `Worker` (kein
`workerSrc`/`workerPort` konfiguriert — pdf.js erkennt Node selbst und
fällt automatisch auf synchrones Parsing im Hauptthread zurück; für einen
kurzlebigen Extraktions-Call pro Job wäre ein `worker_threads`-Worker nur
Overhead).

**Processor-Optionen (seit 2026-09-11):** `rheinagent_file_process_prepare`
nimmt ein optionales `options`-Objekt entgegen (`z.record(z.string(),
z.unknown())` — bewusst lose typisiert, da jeder Processor selbst
entscheidet, was er versteht), gespeichert am `JobRecord` und bei
`process_apply` unverändert an den Processor durchgereicht
(`ProcessorContext.options`). Aktuell nutzt nur `pdf_extract_text` das:
`{"page": N}` extrahiert eine einzelne, 1-indexierte Seite statt des
gesamten Dokuments — der naheliegende Workaround für PDFs, deren
Volltext über der 64-KiB-Ergebnisgrenze liegt. Ein Processor, der
`options` nicht kennt, ignoriert es einfach; ein bekannter, aber
falsch-geformter Wert (z. B. `page: 0` oder `page: "eins"`) scheitert als
klarer Job-Fehler, nie als stiller Fallback auf "ganzes Dokument" oder
"Seite 1".

## Öffentliche Tool-Verträge

Jedes Tool deklariert ein zod-`outputSchema` (siehe `src/lib/schemas.ts`),
das `structuredContent` beschreibt — Clients können das laut Spec gegen
`structuredContent` validieren, statt es blind zu vertrauen.

**Namenskonvention (Wire vs. intern):** Jedes Feld in jedem `inputSchema`
und jedem `outputSchema` ist `snake_case` (`file_id`, `declared_size_bytes`,
`size_bytes`, `pending_delete`, …) — durchgängig, auch für Felder, die aus
internen TypeScript-Records (`FileRecord`/`JobRecord`/`DeleteTicket` in
`src/lib/store.ts`, dort bewusst `camelCase` nach TS-Konvention) stammen.
Die Übersetzung passiert ausschließlich in `src/lib/wire.ts`
(`toWireFile()`/`toWireJob()`/`toWireDeleteTicket()`) — kein Tool-Handler
spreadet einen internen Record je direkt in `structuredContent`. Vor
2026-09-11 mischte der Vertrag beide Konventionen (`FileRecordSchema` &
Co. waren `camelCase`); als Breaking-Change vor jeder echten Kunden-
Integration bereinigt, siehe [BUILDLOG.md](../BUILDLOG.md).

**ID-Validierung am Vertrag, nicht nur intern:** `file_id`/`job_id`/
`upload_id`/`delete_token`-Eingabefelder sind im `inputSchema` selbst per
Regex auf ihr jeweiliges Präfix eingeschränkt (`FileIdField`/`JobIdField`/
`UploadIdField`/`DeleteTokenField` in `src/lib/schemas.ts`, gebaut aus
`idPattern()`/`ID_PREFIXES` in `src/lib/ids.ts`). Eine falsch-geformte oder
ID der falschen Art (z. B. ein `job_id`-Wert an `file_id` übergeben) scheitert
dadurch als saubere MCP-Schema-Validierung, bevor der Handler überhaupt
läuft — nicht erst tief in `assertOpaqueId()` als generischer
"internal error in `<tool>`".

**Wie ein LLM-Client die Tools versteht:** Der Server setzt das
spec-eigene `instructions`-Feld der `initialize`-Antwort (`server.ts`,
`ServerOptions.instructions`) mit einer kompakten Workflow-Kurzanleitung
(Discover → Upload → Inspect → Process → Delete, inkl. "IDs sind opak,
nie selbst konstruieren"). Das erreicht das Modell einmal pro Session ohne
zusätzlichen Tool-Call — aber nicht jeder MCP-Client reicht `instructions`
in den Modellkontext durch. Als Fallback trägt
`rheinagent_file_capabilities_get`s Antwort dieselbe Anleitung zusätzlich
als `usage`-Array (Klartext-Content **und** `structuredContent`), da viele
Agent-Frameworks dieses Tool ohnehin früh in der Session aufrufen. Beide
Quellen kommen aus derselben Konstante `USAGE_STEPS`
(`src/lib/capabilities.ts`), damit sie nicht auseinanderlaufen.
`capabilities.limits` trägt seit 2026-09-11 zusätzlich
`rate_limit_window_ms`/`rate_limits_per_window` (aus `src/lib/rateLimit.ts`
exportiert) — ein Client kennt sein Pacing-Budget dadurch vorab, statt es
erst über einen `rate limit exceeded`-Fehler zu lernen.

| Tool | Input | `structuredContent` (Schema) | Annotations | Rate-Limit-Klasse |
|---|---|---|---|---|
| `rheinagent_file_capabilities_get` | — | `CapabilitiesSchema` | readOnly, idempotent | read |
| `rheinagent_file_health_get` | — | `HealthSchema` | readOnly, idempotent | read |
| `rheinagent_file_upload_prepare` | `filename`, `declared_size_bytes` | `UploadPrepareResultSchema` | — | write |
| `rheinagent_file_upload_finalize` | `upload_id` | `FileRecordSchema` | — | critical |
| `rheinagent_file_list` | `mime_category?`, `filename_contains?`, `cursor?`, `limit?` | `FileListResultSchema` (mit `next_cursor`) | readOnly, idempotent | read |
| `rheinagent_file_get` | `file_id` | `FileViewResultSchema` (+`content` bei kleinen Textdateien) | readOnly, idempotent | read |
| `rheinagent_file_rename` | `file_id`, `new_filename` | `FileRecordSchema` | idempotent | write |
| `rheinagent_file_verify` | `file_id` | `FileVerifyResultSchema` | readOnly, idempotent | read |
| `rheinagent_file_duplicate_check` | genau eins von `file_id`/`sha256` | `DuplicateCheckResultSchema` | readOnly, idempotent | read |
| `rheinagent_file_knowledge_handoff_prepare` | `file_id`, `extraction_job_id?` | `KnowledgeHandoffResultSchema` | readOnly, idempotent | read |
| `rheinagent_file_download_prepare` | `file_id` | `DownloadPrepareResultSchema` | — | write |
| `rheinagent_file_process_prepare` | `file_id`, `processor_id`, `options?` | `JobRecordSchema` | — | write |
| `rheinagent_file_process_apply` | `job_id` | `JobResultEnvelopeSchema` | — | critical |
| `rheinagent_file_job_get` | `job_id` | `JobRecordSchema` | readOnly, idempotent | read |
| `rheinagent_file_job_list` | `file_id?`, `state?`, `processor_id?`, `cursor?`, `limit?` | `JobListResultSchema` (mit `next_cursor`) | readOnly, idempotent | read |
| `rheinagent_file_result_get` | `job_id` | `JobResultEnvelopeSchema` | readOnly, idempotent | read |
| `rheinagent_file_delete_prepare` | `file_id` | `DeleteTicketResultSchema` | — | write |
| `rheinagent_file_delete_apply` | `delete_token` | `FileListResultSchema` (verbleibende Dateien) | **destructiveHint: true**, verlangt Elicitation-Bestätigung | critical |

`rheinagent_file_list` ist cursor-paginiert (`next_cursor` in der Antwort,
als `cursor` beim nächsten Aufruf mitgeben) — wächst dadurch nicht
unbegrenzt durch MCP-JSON, selbst bei vielen akzeptierten Dateien. Seit
2026-09-11 zusätzlich filterbar: `mime_category` (exakt) und
`filename_contains` (case-insensitive Substring) — Filterung passiert in
`listFilesPage()` **vor** der Pagination, sodass `cursor`/`next_cursor`
über die gefilterte Ergebnismenge laufen, nicht über den kompletten
Bestand. `rheinagent_file_job_list` folgt demselben Muster (zusätzlich
`file_id`/`state`/`processor_id` filterbar, z. B. um alle fehlgeschlagenen
Jobs zu finden) — ohne dieses Tool gab es keinen Weg zurück, wenn eine
`job_id` verloren ging. Details zu Rate-Limiting und der Löschbestätigung:
[SECURITY.md](SECURITY.md).

`rheinagent_file_rename` ändert ausschließlich `filename` — `file_id`,
Bytes, `sha256` und `mime_category` bleiben unverändert. Der neue Dateiname
muss weiterhin auf dieselbe `mime_category` klassifizieren wie die bereits
per Magic-Bytes validierten Bytes (`classifyExtension()` in
`security.ts`); ein Rename, der die effektive Kategorie ändern würde (z. B.
eine als `text` validierte Datei auf `.pdf` umbenennen), wird abgelehnt —
sonst könnte ein Rename die Extension/Magic-Byte-Konsistenzprüfung aus
`upload_finalize` im Nachhinein unterlaufen.

`rheinagent_file_verify` liest die Bytes einer Datei neu von der Platte und
berechnet ihren SHA-256 neu, verglichen mit dem bei `upload_finalize`
erfassten Wert (`verifyFile()` in `store.ts`) — die einzige Stelle, die
Integrität **nach** der Annahme erneut prüft; `upload_finalize` selbst
prüft nur einmalig beim Empfang. Rein lesend, verändert nichts, unabhängig
vom Ergebnis. Ein `matches: false` markiert das Tool bewusst **nicht** als
`isError` — dieselbe Konvention wie bei `rheinagent_file_health_get`s
`status: "degraded"`: das Tool ist erfolgreich gelaufen und hat einen
echten Befund geliefert, `isError` bleibt für gescheiterte Tool-Aufrufe
selbst reserviert, nicht für Fachdaten, die der Aufrufer aus `matches`
lesen muss.

## Audit-/Release-Grenze

Dieses Repo enthält keine eigene Audit-Speicherung, keinen eigenen
Lizenz-Client und keine Signier-/Verteil-Logik — siehe [AUDIT.md](AUDIT.md),
[LICENSE-FLOW.md](LICENSE-FLOW.md), [VERSIONING.md](VERSIONING.md).

## MCP-App-UI (optional)

Es existiert aktuell **keine** angebundene MCP-App-UI für diese Tool-Menge
(ein früherer Prototyp mit abweichenden Tool-Namen wurde entfernt, siehe
[BUILDLOG.md](../BUILDLOG.md)). Alle Business-Funktionen sind vollständig
ohne UI nutzbar — eine UI-Wiederanbindung ist ein späteres, optionales
Fast-Follow, siehe [HANDOFF.md](HANDOFF.md).
