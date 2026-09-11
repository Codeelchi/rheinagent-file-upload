# Handoff

Stand: 2026-09-11. Dieses Dokument listet **alles**, was außerhalb von
`Codeelchi/rheinagent-file-upload` erledigt werden muss, bevor dieses Produkt
für echte Kunden nutzbar ist. Dieses Repo nimmt keine der folgenden Änderungen
selbst vor — ausschließlich schreibend in diesem Repo, wie vorgegeben.

## Einstieg für eine neue Session

- Letzter Commit auf `main`: siehe `git log -1` — Arbeitsverzeichnis zum
  Zeitpunkt dieses Eintrags sauber, lokal = `origin/main`, keine offenen
  Änderungen.
- Lokaler Checkout: `/home/Technowolf/mcp-ui-test` auf `berry`.
- Server starten: `npm run serve` (Control Plane, Port 3901) **und**
  `npm run serve:dataplane` (Data Plane, Port 3902) — beide nötig für
  Uploads/Downloads. `npm run check` bündelt Typecheck + Tests (= das
  Release-Gate aus [VERSIONING.md](VERSIONING.md)) in einem Befehl; `npm
  test`/`npm run typecheck` einzeln bei Bedarf.
- Arbeits-Workflow für dieses Repo (siehe auch Memory
  `feedback_mcp_ui_test_workflow`): jede Änderungsrunde endet mit einem
  `BUILDLOG.md`-Eintrag + Push nach `github.com/Codeelchi/rheinagent-file-upload`,
  ohne dass der Nutzer danach fragen muss.
- **Wichtigster nächster fachlicher Schritt:** Audit-Hub-Live-Verifikation
  (`src/lib/audit.ts` ist nur gegen die Dokumentation implementiert, nie
  gegen eine laufende `rheinagent-audit`-Instanz getestet) — siehe Abschnitt
  "Offene Cross-Repo-Integrationsarbeit" Punkt 4 unten. Diese Session hatte
  dazu keinen Zugriff auf eine laufende Hub-Instanz (kein `rheinagent-audit`-
  Profil in den verfügbaren MCP-Connectoren) und hat stattdessen den
  nächsten unblockierten Punkt erledigt (Download-Endpunkt, siehe unten).
- Vollständiger aktueller Funktionsstand: alle 16 Tools implementiert und
  end-to-end verifiziert (Upload/Download/Rename/Verify/Process/Delete-Flow,
  Health/Doctor inkl. Storage-Stats+Mime-Breakdown, filterbares
  File-/Job-Listing, parametrisierbare Processor-Optionen (Seitenauswahl
  bei `pdf_extract_text`), Pagination, Elicitation-Bestätigung, Legacy- und
  moderner `2026-07-28`-Protokollpfad). 5 Processor registriert
  (Text/PDF/Image), 86 automatisierte Tests. Details: `BUILDLOG.md`
  (neuester Eintrag oben).

## Verbindlicher License-/Distribution-Flow (Referenz)

Siehe [LICENSE-FLOW.md](LICENSE-FLOW.md) für den vollständigen Fluss. Dieses
Produkt ist Stand heute **nicht** in diesen Fluss eingebunden.

## Source of truth

GitHub (`Codeelchi/rheinagent-file-upload`, Branch `main`). Referenzstand der
gelesenen Plattform-Repos bei Implementierung dieser Version:

| Repo | Commit (main) |
|---|---|
| `rheinagent-manager` | `ef01dacdcf992dffdecb0615c559844f67d54e3d` |
| `rheinagent-license` | `63064382633050bf8d5e89239defb8bfbecaff24` |
| `rheinagent-update-feed` | `7848fe0d58683e34a3edf56d0b8525aebf5c58f2` |
| `rheinagent-audit` | `eb6765ed2c5e59ae9ae66021211e02fed66fae6a` |
| `rheinagent-knowledge-mcp` | `ab7308a632f60c89b17fdf9dc175d96e7b54a386` |
| `rheinagent-backoffice` | `a518dafe94497b72fcde7f305e481e4b5dd55561` |

**Diese SHAs sind bewusst nicht als dauerhaft gültig zu behandeln** — vor
jeder künftigen Änderung an diesem Produkt, die sich auf einen der obigen
Verträge stützt, erneut den aktuellen `main`-Stand prüfen.

## Offene Cross-Repo-Integrationsarbeit

### 1. `rheinagent-license`
- Neue Produktzeile `product_slug: "rheinagent-file-upload"` mit Kanälen
  `stable`/`candidate` anlegen.
- Mindestens ein Test-Entitlement (`can_install: true, can_update: true`)
  für einen Test-Kunden erzeugen, um den Abnahmekriterien-Flow aus
  [LICENSE-FLOW.md](LICENSE-FLOW.md) durchspielen zu können.

### 2. `rheinagent-manager`
- `rheinagent-file-upload@1` zur vertrauten Package-v2-Profilliste
  hinzufügen (Code-Review-pflichtig laut `PACKAGE-CONTRACT-V2.md`) — exakte
  Strategie/Service-Identität für Windows noch offen, siehe
  [VERSIONING.md](VERSIONING.md) Zielstruktur.
- Entscheidung treffen: `installers={}` (Manager-owned Fresh-Bootstrap) oder
  klassischer Strategie-Pfad wie bei Mail/Knowledge.

### 3. `rheinagent-update-feed`
- Produkt-Manifest-Eintrag für `rheinagent-file-upload` anlegen, inkl.
  Kanal-Routing `stable`/`candidate`.

### 4. `rheinagent-audit`
- Audit-Profil `rheinagent-file-upload@1` mit der in [AUDIT.md](AUDIT.md)
  dokumentierten Allowlist-Tabelle serverseitig registrieren.
- Service-Credential für dieses Produkt ausstellen (eigene Service-Chain).
- **Den implementierten Write-Ahead-Client (`src/lib/audit.ts`) gegen eine
  echte Hub-Instanz verifizieren** — bisher nur gegen die Dokumentation
  implementiert, nie live getestet. Das ist der wichtigste offene technische
  Punkt dieses Handoffs.

## Plattform-Inkonsistenzen (beim Lesen der Referenz-Repos gefunden, nicht hier gelöst)

1. **Audit-Endpoint-Variablenname uneinheitlich**: `rheinagent-backoffice`
   nutzt `RA_AUDIT_ENDPOINT`, `rheinagent-knowledge-mcp` nutzt
   `RA_AUDIT_HUB_URL`. Dieses Produkt folgt `backoffice`. Eine
   plattformweite Vereinheitlichung wäre Sache von `rheinagent-audit`
   selbst (Dokumentation/SDK), nicht dieses Produkts.
2. Die Produktvorgabe für dieses Repo nannte `Codeelchi/rheinagent-mail-mcp`
   als Referenz-Repo — der tatsächliche Name ist `Codeelchi/mailmcp`. Für
   künftige Architektur-Checks den korrekten Namen verwenden.

## Innerhalb dieses Repos noch offen (nicht Cross-Repo, aber unerledigt)

- **Kein Docker-Setup** für Control-/Data-Plane als zwei Services.
- **Keine MCP-App-UI** für die aktuelle Tool-Menge (der frühere Prototyp mit
  anderen Tool-Namen wurde entfernt, siehe [BUILDLOG.md](../BUILDLOG.md)).
  UI ist laut Vorgabe optional — Business-Funktionen sind vollständig ohne
  UI nutzbar; eine Wiederanbindung ist rein additiv und blockiert nichts.
- **Archiv-/Entpack-Processor nicht vorhanden** — Archivformate werden
  komplett abgelehnt (siehe [SECURITY.md](SECURITY.md)); sobald ein
  Entpack-Processor gewünscht ist, müssen dafür echte Archive-Bomb-Limits
  (Tiefe, Gesamtgröße entpackt, Dateianzahl) neu entworfen werden.
- **Keine Mandanten-/Nutzertrennung** — einzige, geteilte Namespace pro
  Instanz (siehe [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md)).

## 2026-09-11 erledigt (vorher hier offen gelistet)

- **GitHub-Actions-CI-Workflow.** `.github/workflows/ci.yml` — `npm ci` +
  `npm run check` (Typecheck + alle 86 Tests) bei jedem Push/PR gegen
  `main`. Vorher lief `npm run check` nur manuell; jetzt automatisiert
  abgesichert.
- **`rheinagent_file_verify` (Integritäts-Check) + parametrisierbare
  Processor-Optionen.** Zwei weitere Features:
  1. **`rheinagent_file_verify`** (neu, 16. Tool) — liest eine Datei neu von
     der Platte, berechnet SHA-256 neu, vergleicht gegen den bei
     `upload_finalize` erfassten Wert. Die einzige Stelle, die Integrität
     nach der Annahme erneut prüft (Disk-Korruption, Bit Rot auf einer
     langlebigen Pi-SD-Karte, manuelle Eingriffe in `data/files/` außerhalb
     dieses Produkts). Rein lesend; ein Mismatch ist **kein** `isError`
     (dieselbe Konvention wie `health_get`s `status: "degraded"`), sondern
     ein echter Befund im `matches`-Feld.
  2. **Processor-Optionen** — `process_prepare` nimmt jetzt ein optionales
     `options`-Objekt entgegen, gespeichert am `JobRecord`, unverändert an
     den Processor durchgereicht. `pdf_extract_text` nutzt das als erstes:
     `{"page": N}` extrahiert eine einzelne Seite statt des ganzen
     Dokuments — der Workaround für PDFs über der 64-KiB-Ergebnisgrenze.
     Ein unbekannter/falsch-geformter Wert scheitert als klarer Job-Fehler,
     nie als stiller Fallback.
  - Live end-to-end verifiziert: 2-seitige Test-PDF hochgeladen,
    `options: {"page": 2}` liefert exakt "Page Two Text", `options` rundet
    korrekt im `job_get`, `options: {"page": 99}` scheitert sauber als
    Job-Fehler mit klarer Meldung. `verify` gegen unveränderte Datei
    (`matches: true`) und nach manuellem Byte-Tampering auf der Platte
    (`matches: false`) beide bestätigt.
  - 17 neue automatisierte Tests (u. a. neues `test/jsonIndex.test.ts` —
    vorher das einzige `src/lib`-Modul ganz ohne dedizierte Tests, obwohl
    es der Persistenz-Layer unter jeder einzelnen Store-Operation ist) —
    jetzt **16 Tools, 86 automatisierte Tests**, `npm run check`
    fehlerfrei.
- **Filter für `file_list`/`job_list`, Mime-Category-Storage-Breakdown.**
  Weitere Runde funktionaler Verbesserungen:
  - `rheinagent_file_list` filterbar nach `mime_category` (exakt) und
    `filename_contains` (case-insensitive Substring) — Filterung läuft in
    `listFilesPage()` vor der Pagination.
  - `rheinagent_file_job_list` zusätzlich filterbar nach `state`
    (`prepared`/`completed`/`failed`) und `processor_id` — z. B. "alle
    fehlgeschlagenen Jobs" jetzt direkt abfragbar.
  - `rheinagent_file_health_get`s `storage` liefert zusätzlich
    `by_mime_category` (Anzahl+Bytes pro Kategorie). **Live-Bug gefangen
    und gefixt:** `z.record(MimeCategorySchema, ...)` verlangt laut zod v4
    alle Enum-Werte als Keys — jede reale Instanz ohne Archiv-Upload schlug
    dadurch mit `Output validation error` fehl. Fix: `z.partialRecord(...)`.
    Neuer Regressionstest (`test/contracts.test.ts`) prüft genau diesen Fall.
  - 5 neue automatisierte Tests — jetzt **69 automatisierte Tests**.
  - Live end-to-end verifiziert (inkl. des gefundenen und gefixten Bugs).
- **PDF/Image-Processoren, Prepare-Zeit-Mime-Check, Job-Listing, Storage-
  Stats, Rename.** Fünf funktionale Verbesserungen auf einmal umgesetzt:
  1. **PDF/Image-Processoren** — `pdf` und `image` waren erlaubte
     `mime_category`-Werte, aber ohne jeden Processor. Neu: `image_metadata`
     (PNG/JPEG-Dimensionen, per Hand geparst, keine Bildbibliothek),
     `pdf_metadata` + `pdf_extract_text` (via `pdfjs-dist`, bewusst ohne
     dessen native `@napi-rs/canvas`-Alternative `pdf-parse` — siehe
     [SECURITY.md](SECURITY.md)). Jetzt 5 Processor statt 2.
  2. **`process_prepare` prüft `processor_id` gegen `mime_category`
     vorab** (`processorSupportsMimeCategory()`) — ein Mismatch (z. B.
     `text_stats` auf eine PDF) wird sofort mit klarer Fehlermeldung
     abgelehnt, statt erst nach einem echten `process_apply`-Versuch mit
     `state: "failed"` zu enden.
  3. **`rheinagent_file_job_list`** (neu) — Pendant zu `rheinagent_file_list`
     für Jobs, optional nach `file_id` gefiltert, cursor-paginiert. Vorher
     gab es keinen Weg zurück, wenn eine `job_id` verloren ging.
  4. **Storage-Stats in `rheinagent_file_health_get`** — `storage.file_count`/
     `total_bytes`/`staging_file_count`, damit ein Client den aktuellen
     Verbrauch kennt, ohne `rheinagent_file_list` komplett durchzupaginieren.
  5. **`rheinagent_file_rename`** (neu) — ändert nur den Anzeigenamen; ein
     Rename, das die effektive `mime_category` ändern würde (z. B. `.txt`
     → `.pdf`), wird abgelehnt, damit die Extension/Magic-Byte-Konsistenz
     aus `upload_finalize` nicht im Nachhinein unterlaufen werden kann.
  - `capabilities.processors` liefert jetzt `{id, supported_mime_categories}`
    statt nur IDs — ein Client sieht direkt, welcher Processor zu welcher
    Datei passt, ohne Trial-and-Error.
  - Live end-to-end getestet: Upload von Text/PDF/PNG, Mismatch-Ablehnung
    bei `process_prepare`, alle 5 Processor gegen echte Dateien, `job_list`
    gefiltert nach `file_id`, Rename (erlaubt + abgelehnt), `health_get`-
    Storage-Stats, `capabilities_get`-Processor-Schema — alles wie erwartet.
  - 20 neue automatisierte Tests (`test/processors.test.ts` neu, 10 neue in
    `test/store.test.ts`) — jetzt **15 Tools, 5 Processor, 64 automatisierte
    Tests**, `npm run check` fehlerfrei.
  - Neue Abhängigkeit: `pdfjs-dist` (null eigene Laufzeit-Abhängigkeiten,
    siehe [SECURITY.md](SECURITY.md) zur Supply-Chain-Begründung).
- **Cascade Delete, Staging-Reaper, CORS entfernt.** Drei Funde aus einer
  weiteren Codedurchsicht: (1) `delete_apply` löschte Jobs/Ergebnisse der
  gelöschten Datei nicht mit — ein `text_uppercase`-Ergebnis (voller
  transformierter Dateiinhalt) blieb nach "Löschung" für immer abrufbar;
  jetzt kaskadierend entfernt (`cascadeDeleteJobsForFile()`). (2)
  Verwaiste Staging-Bytes bei PUT-ohne-Finalize wuchsen unbegrenzt an;
  neuer `sweepOrphanedStaging()`-Reaper (Start + alle 15 min). (3) `cors()`
  lief ohne Origin-Einschränkung, obwohl kein legitimer MCP-Client CORS
  braucht — komplett entfernt (`npm uninstall cors @types/cors`). Live
  verifiziert (Reaper: künstlich verwaister Eintrag + Neustart → Log zeigt
  `removed_files:1,removed_entries:1`, danach nachweislich weg; CORS:
  `Origin`-Header liefert keinen `Access-Control-Allow-Origin` mehr). 4
  neue Tests — jetzt **48 automatisierte Tests**.
- **Tool-Verträge auditiert + LLM-Erklärbarkeit umgesetzt.** Auf Anfrage
  ("stelle sicher, dass die Tools korrekte Beschreibungen/Verträge haben
  und recherchiere zum capabilities-Tool, um einem LLM die Funktionen zu
  erklären") alle 13 Tool-Beschreibungen/Contracts durchgesehen und drei
  echte Lücken gefunden + behoben:
  1. **Wire-Format war inkonsistent** — `FileRecordSchema`/`JobRecordSchema`/
     `DeleteTicketResultSchema` gaben `camelCase` zurück (direkt aus den
     internen `store.ts`-Records gespreadet), während jedes Tool-Input-Feld
     (`file_id`, `declared_size_bytes`, …) und `UploadPrepareResultSchema`/
     `DownloadPrepareResultSchema` bereits `snake_case` waren. Jetzt
     durchgängig `snake_case` über einen neuen Mapping-Layer
     (`src/lib/wire.ts`: `toWireFile()`/`toWireJob()`/
     `toWireDeleteTicket()`) — bewusst als Breaking-Change vor jeder
     echten Kunden-Integration bereinigt, siehe
     [VERSIONING.md](VERSIONING.md) Schema-Kompatibilität.
  2. **`file_id`/`job_id`/`upload_id`/`delete_token`-Eingaben waren nur
     lose `z.string()`** — eine falsche oder falsch-geformte ID scheiterte
     dadurch als generischer "internal error in `<tool>`" statt als
     saubere Validierungsmeldung. Jetzt per-Kind-Regex direkt im
     `inputSchema` (`FileIdField`/`JobIdField`/`UploadIdField`/
     `DeleteTokenField` in `src/lib/schemas.ts`, gebaut aus
     `idPattern()`/`ID_PREFIXES` in `src/lib/ids.ts`) — lehnt auch eine ID
     der falschen Art ab (z. B. `job_id` an `file_id` übergeben), nicht
     nur "irgendein opaker String".
  3. **Kein Mechanismus, der einem LLM-Client das Workflow-Muster
     erklärt.** Recherche in den MCP-SDK-Typen ergab: das spec-eigene
     `instructions`-Feld der `initialize`-Antwort
     (`ServerOptions.instructions` in `@modelcontextprotocol/server`) ist
     genau dafür vorgesehen, wurde aber nie gesetzt. Jetzt gesetzt
     (`server.ts`, `SERVER_INSTRUCTIONS`) — eine kompakte Workflow-
     Kurzanleitung (Discover → Upload → Inspect → Process → Delete + "IDs
     sind opak"). Da nicht jeder MCP-Client `instructions` an das Modell
     durchreicht, trägt `rheinagent_file_capabilities_get`s Antwort
     dieselbe Anleitung redundant als neues `usage`-Feld (Klartext-Content
     **und** `structuredContent`) — beide Quellen aus derselben Konstante
     `USAGE_STEPS` (`src/lib/capabilities.ts`), damit sie nicht
     auseinanderlaufen.
  - Live end-to-end verifiziert: `initialize`-Antwort trägt `instructions`,
    `capabilities_get` trägt `usage`, `upload_finalize`/`get` liefern
    `snake_case`, eine `job_id` als `file_id` und ein Path-Traversal-String
    scheitern beide als klare `Input validation error` statt als internal
    error. 9 neue automatisierte Tests (`test/contracts.test.ts`) für die
    ID-Feld-Validatoren und Wire-Mapper — jetzt **41 automatisierte Tests**,
    `npx tsc --noEmit` fehlerfrei. Tool-Anzahl unverändert bei 13 (reine
    Vertragsverbesserung, keine neuen Tools).
- **Bind-Host-Standard auf `127.0.0.1` geändert.** Beide Prozesse lauschten
  vorher ohne expliziten Host (`app.listen(PORT)`), was auf Node/Express
  `0.0.0.0` bedeutet — auf einem Homelab-Host im Tailnet/LAN ungeschützt
  erreichbar, da diese Version kein TLS/Auth auf HTTP-Ebene hat (siehe
  [SECURITY.md](SECURITY.md)). Neue Env-Var
  `RHEINAGENT_FILE_UPLOAD_BIND_HOST` (Default `127.0.0.1`), siehe
  [INSTALLATION.md](INSTALLATION.md).
- **Health/Doctor-Tool.** `rheinagent_file_health_get` implementiert das
  Health-Profil `rheinagent-file-upload-v1` aus [VERSIONING.md](VERSIONING.md):
  Data-Plane-Erreichbarkeit (`GET /healthz`, neu), Staging-/Files-
  Verzeichnis-Schreibbarkeit, und im `hub`-Audit-Modus Config-Vollständigkeit
  + `checkHubEndpointReachable()` als bewusst protokoll-loser
  Best-Effort-Netzwerkcheck (`src/lib/audit.ts`) — **kein** Beweis, dass der
  Write-Ahead-Vertrag selbst funktioniert. Live end-to-end getestet in drei
  Zuständen (beide Planes up → `ok`; Data Plane down → `degraded`;
  `RA_AUDIT_MODE=hub` mit unerreichbarem Endpoint → `degraded` +
  `hub_endpoint_reachable: false`, keine Credentials im Output). 6 neue
  automatisierte Tests (`test/audit.test.ts`, 2 neue in `test/store.test.ts`)
  — jetzt **13 Tools, 36 automatisierte Tests**, `npx tsc --noEmit` fehlerfrei.
  Auf Nutzerwunsch vor dem CI-Workflow priorisiert (siehe oben).
- **Download-Endpunkt für große/binäre Dateien.** Neues Tool
  `rheinagent_file_download_prepare` (Control Plane) legt ein befristetes,
  wiederverwendbares `download_token` an (`data/meta/downloads.json`,
  15 min TTL, analog zu `PendingUpload`); `GET /download/:downloadToken`
  auf der Data Plane streamt die Bytes mit `Content-Disposition: attachment`.
  Verweigert Downloads für unbekannte/abgelaufene Token (`404`) und für
  bereits gelöschte/`pendingDelete`-Dateien (`410`/Prepare-Fehler). Live
  end-to-end getestet (Upload → Finalize → Download-Prepare → GET, inkl.
  Token-Wiederverwendung und der beiden Fehlerfälle) und mit 4 neuen
  Store-Tests (`test/store.test.ts`) automatisiert abgesichert — jetzt
  **12 Tools**, 30 automatisierte Tests, `npx tsc --noEmit` fehlerfrei.
  `rheinagent_file_get`s Beschreibung verweist jetzt auf dieses Tool statt
  auf einen "future data-plane endpoint".
- **SDK-Migration auf Protokoll `2026-07-28`** — `@modelcontextprotocol/server`
  + `@modelcontextprotocol/node` (v2) statt des alten
  `@modelcontextprotocol/sdk` (max. `2025-11-25`). Legacy- und moderne
  Clients laufen über denselben `/mcp`-Endpunkt (`createMcpHandler`-Shim
  bestätigt getestet gegen `2025-06-18`-Handshake und `2026-07-28`-stateless-
  Requests inkl. `Mcp-Method`/`Mcp-Name`-Headern).
- **`outputSchema` für alle 11 Tools** (`src/lib/schemas.ts`, zod → JSON Schema).
- **Tool-Annotations** (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`).
- **Rate-Limiting** (`src/lib/rateLimit.ts`, pro Tool-Name, 3 Gewichtsklassen) — vorher 0 % umgesetzt, jetzt Pflichtanforderung der Spec erfüllt.
- **Pagination für `rheinagent_file_list`** (`cursor`/`next_cursor`, deterministische Sortierung).
- **Elicitation-Bestätigung vor `delete_apply`** (Multi-Round-Trip, `InputRequiredResult` → `elicitation/create` → `inputResponses`) — live End-to-End getestet (ohne Bestätigung → `input_required`, mit Bestätigung → tatsächliche Löschung).
- **Strukturiertes Logging** (`src/lib/logging.ts`, stderr-JSON) statt `console.log` — bewusst **nicht** über die MCP-`notifications/message`-Utility, da diese laut Spec (SEP-2577) für `2026-07-28` deprecated ist.

**Noch nicht umgesetzt aus der ursprünglichen Verbesserungsliste:**
Resource-Exposure (`resources/list`/`resources/read` für Dateien, zusätzlich
zu den Tools) — bewusst zurückgestellt, da additiv und nicht
sicherheitskritisch.

## Nächster Schritt nach jedem obigen Punkt

Reihenfolge-Empfehlung: (1) Audit-Hub-Live-Verifikation, weil sie die
Kernarchitektur bestätigt, bevor mehr draufgebaut wird — technisch aber nur
mit Zugriff auf eine laufende `rheinagent-audit`-Instanz machbar, den diese
Session nicht hatte → (2) License/Manager/Update-Feed-Registrierung, weil sie
Voraussetzung für jeden echten Kunden-Test ist → (3) Docker-Setup, weil es
den Betrieb erleichtert, aber nichts Funktionales freischaltet → (4)
UI-Wiederanbindung, da explizit optional. Download-Endpunkt, Health/Doctor-
Tool und CI-Workflow (vormals Punkt 3) sind seit 2026-09-11 erledigt, siehe
oben.
