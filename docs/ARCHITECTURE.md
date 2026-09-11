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
│  13 öffentliche Tools    │       │  keine MCP-Tools, kein     │
│  Business-/Sicherheits-  │       │  Audit, keine Business-    │
│  logik, Audit-Aufrufe    │       │  logik — Staging-Write,    │
│                           │       │  Download-Read, /healthz  │
└────────────┬─────────────┘       └────────────┬──────────────┘
             │                                   │
             └──────────────┬────────────────────┘
                             ▼
                    data/ (gemeinsames Dateisystem)
                    staging/  files/  results/  meta/*.json
```

Beide Prozesse sind **getrennt**, weil große Binärdaten nie durch MCP-JSON
laufen sollen: der Control-Plane-Prozess kennt nur `upload_id`/`file_id`/
`job_id`, nie rohe Bytes im Request/Response-Pfad (außer dem Sonderfall
kleiner Text-Inhalte in `rheinagent_file_get`, siehe unten). Beide Prozesse
teilen sich ausschließlich das Dateisystem unter `data/`, nicht den
Prozessspeicher — jede Metadaten-Tabelle liest/schreibt bei jedem Zugriff
frisch von Platte (`src/lib/jsonIndex.ts`), damit keiner der beiden Prozesse
mit einem veralteten In-Memory-Stand des anderen arbeitet.

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
| Löschung | `rheinagent_file_delete_prepare` markiert `pendingDelete`, Datei bleibt vorerst liegen | `rheinagent_file_delete_apply` entfernt die Datei endgültig anhand des `delete_token` |

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
zu hinterlassen. Im `hub`-Audit-Modus meldet das Tool zusätzlich, **ob**
`RA_AUDIT_ENDPOINT`/`RA_AUDIT_SERVICE_ID`/`RA_AUDIT_CREDENTIAL_PATH` gesetzt
sind (nie die Werte selbst) sowie `hub_endpoint_reachable` — ein bewusst
protokoll-loser Best-Effort-Netzwerk-Check (`checkHubEndpointReachable()`
in `src/lib/audit.ts`, siehe Kommentar dort), **kein** Beweis, dass der
Write-Ahead-Vertrag selbst funktioniert (der bleibt implementiert, aber
unverifiziert, siehe [HANDOFF.md](HANDOFF.md)). `status` ist `"degraded"`,
sobald irgendeine dieser Prüfungen negativ ausfällt.

## Processor-Registry

`src/lib/processors.ts` enthält eine feste `Map<string, Processor>`. Ein
Processor ist eine zur Build-Zeit registrierte TypeScript-Funktion, die eine
lokale Datei liest und ein JSON-Ergebnis zurückgibt — kein Shell-Aufruf, kein
`eval`, keine vom Client mitgelieferte Logik. Neue Fähigkeiten bedeuten einen
neuen Registry-Eintrag plus Release, nie eine Laufzeit-Erweiterung durch ein
MCP-Tool. Aktuell registriert: `text_stats`, `text_uppercase` (beide nur für
Text-Dokumente, siehe [SECURITY.md](SECURITY.md) zur MIME-Kategorisierung).

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
| `rheinagent_file_list` | `cursor?`, `limit?` | `FileListResultSchema` (mit `next_cursor`) | readOnly, idempotent | read |
| `rheinagent_file_get` | `file_id` | `FileViewResultSchema` (+`content` bei kleinen Textdateien) | readOnly, idempotent | read |
| `rheinagent_file_download_prepare` | `file_id` | `DownloadPrepareResultSchema` | — | write |
| `rheinagent_file_process_prepare` | `file_id`, `processor_id` | `JobRecordSchema` | — | write |
| `rheinagent_file_process_apply` | `job_id` | `JobResultEnvelopeSchema` | — | critical |
| `rheinagent_file_job_get` | `job_id` | `JobRecordSchema` | readOnly, idempotent | read |
| `rheinagent_file_result_get` | `job_id` | `JobResultEnvelopeSchema` | readOnly, idempotent | read |
| `rheinagent_file_delete_prepare` | `file_id` | `DeleteTicketResultSchema` | — | write |
| `rheinagent_file_delete_apply` | `delete_token` | `FileListResultSchema` (verbleibende Dateien) | **destructiveHint: true**, verlangt Elicitation-Bestätigung | critical |

`rheinagent_file_list` ist cursor-paginiert (`next_cursor` in der Antwort,
als `cursor` beim nächsten Aufruf mitgeben) — wächst dadurch nicht
unbegrenzt durch MCP-JSON, selbst bei vielen akzeptierten Dateien. Details
zu Rate-Limiting und der Löschbestätigung: [SECURITY.md](SECURITY.md).

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
