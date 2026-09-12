## 2026-09-12 - Manager/License/Update-Feed Distribution Integration

- Package-v2 Windows distribution implemented under `packaging/distribution/`.
- Trusted activation contract is exactly `rheinagent-file-upload@1` / `windows-versioned-runtime-v1`; minimum Manager is `0.4.0-rc.7`.
- GitHub and Forgejo distribution workflows build a real Windows bundled-Node runtime and a signed Package-v2 smoke using only an ephemeral CI key.
- Production public-key trust anchor is tracked as a public key only; exact SHA-256 is `1c4f5d5ad3313381b7d96d8782c853d950a87ad2f6a285b2c060d325d77e4a15`.
- Local distribution gate PASS: 166/167 tests PASS (1 privilege skip), runtime builder PASS, 11 processor imports PASS, Package-v2 build+verify PASS, package size 49,659,111 bytes.
- Cross-repo implementation exists in Manager RC7, License Service and Update Feed integration branches. Publication/production E2E must use the accepted protected signing path; no ad-hoc production private key was created.
- `.state/` and Python `__pycache__/` are ignored; local ephemeral signing material was removed after the smoke.
# Handoff

Stand: 2026-09-12. Dieses Dokument listet **alles**, was auÃŸerhalb von
`Codeelchi/rheinagent-file-upload` erledigt werden muss, bevor dieses Produkt
fÃ¼r echte Kunden nutzbar ist. Dieses Repo nimmt keine der folgenden Ã„nderungen
selbst vor â€” ausschlieÃŸlich schreibend in diesem Repo, wie vorgegeben.

## Einstieg fuer eine neue Session

- Arbeitsbranch: `claude/mcp-server-continuation-fb3oq2`, PR #1 gegen `main`.
  Den tatsaechlichen Git-/PR-/CI-Stand immer zuerst erneut pruefen; keine hier
  genannte SHA blind voraussetzen.
- Server starten: `npm run serve` (Control Plane, Port 3901) **und**
  `npm run serve:dataplane` (Data Plane, Port 3902). Produktionsbuild:
  `npm run build` + `npm run start`/`start:dataplane`. Docker/Compose siehe
  [INSTALLATION.md](INSTALLATION.md).
- `npm run check` ist das lokale Release-Gate. Stand 2026-09-12 auf dem
  Windows-Testhost: **167 Tests, 166 PASS, 1 SKIP, 0 FAIL**. Der einzige Skip
  ist der echte Symlink-Erzeugungstest, wenn der Windows-Account Symlinks mit
  `EPERM` verbietet; Linux-CI fuehrt ihn real aus. `npm run build` und
  `git diff --check` sind ebenfalls PASS.
- Funktionsstand: **18 oeffentliche Tools, 11 Processor** fuer
  Text/Markdown/CSV/JSON/PDF/Image/DOCX/XLSX; SQLite/WAL-Persistenz, Chunking,
  Duplikat-Erkennung, nicht-autoritatives Knowledge-Handoff, Health/Doctor,
  Docker/Compose sowie Control-/Data-Plane-Trennung.
- Am 2026-09-12 wurde bei einem echten **kompilierten** Runtime-Test ein
  Source-vs.-`dist`-Pfadfehler entdeckt: feste `import.meta.dirname/../..`-
  Annahmen zeigten nach `tsc` auf `dist/`. Behoben durch
  `src/lib/runtimePaths.ts`; `RHEINAGENT_FILE_UPLOAD_DATA_DIR` erlaubt einen
  expliziten Data-Root. `PRODUCT_VERSION` nutzt denselben Root-Resolver.
- Control- und Data-Plane haben jetzt Graceful Shutdown fuer `SIGINT`/`SIGTERM`
  und schliessen SQLite-Handles kontrolliert. Das ist insbesondere fuer
  Windows-Update/Rollback relevant.
- Der kompilierte Vollflow wurde lokal live verifiziert:
  Upload->Finalize->Extraction->Result->Duplicate->Knowledge-Handoff->Download->
  Verify, danach Neustart beider Prozesse und erneute Pruefung von Datei,
  SQLite, Job und Result. Persistenz: PASS. `dist/data` wurde nicht angelegt.
- Die bisherige GitHub-CI mit reinem `docker build` wurde durch
  `docker-runtime-smoke` ersetzt: echter `docker compose up -d --build`,
  beide Planes live, voller MCP+Data-Plane-Flow, Container-Restart und
  Persistenzpruefung. Der lokale Windows-Testhost hat **keinen** laufenden
  Docker-Daemon; deshalb ist der GitHub-Job die autoritative Container-Abnahme.
- Forgejo-Distribution ist jetzt als separates CI-Gate verifiziert. Das
  interne Repo `rheinagent/rheinagent-file-upload` fuehrt denselben
  Feature-Branch; den tatsaechlichen Remote-HEAD weiterhin zu Sitzungsbeginn
  pruefen. Der erste native Forgejo-Lauf auf `6a71690` zeigte einen echten
  Runner-Unterschied: `check` war gruen, `docker-runtime-smoke` scheiterte
  sofort, weil das fuer `ubuntu-latest` verwendete `node:lts`-Job-Image keinen
  Docker-CLI enthielt.
- Commit `a808e5d` haertet deshalb nur den Forgejo-Pfad: moderne
  `docker-ce-cli` + Compose-Plugin aus dem offiziellen Docker-APT-Repository,
  dynamisch ermitteltes Remote-DinD-Gateway, CI-Bind auf `0.0.0.0` und ein
  eigener Restart-/Persistenz-Smoke. Derselbe Aufbau wurde lokal in einem
  echten verschachtelten Docker-in-Docker-Szenario erfolgreich durchlaufen.
- GitHub Run `34701497630` auf `a808e5d` ist gruen. Der native Forgejo-
  `workflow_dispatch` Run `39` auf exakt demselben Commit ist ebenfalls
  **SUCCESS**; beide Jobs `check` und `docker-runtime-smoke` sind gruen.

- **Audit-Hub-Gate ist abgeschlossen:** Der produkt-eigene Adapter und das
  Profil `rheinagent-file-upload@1` wurden am 2026-09-12 gegen eine echte,
  isolierte `rheinagent-audit-core 0.2.0rc1`-Instanz live verifiziert. INTENT ->
  APPLY -> VERIFY -> RESULT, authentifizierter Service-Health, Invocation und
  Fail-closed vor der Mutation bei ungueltiger Service-ID sind PASS; offene
  Intents nach Abschluss: 0. Der produktive Mail-Hub blieb unberuehrt.
- **Naechstes zentrales Gate:** License/Manager/Update-Feed-Registrierung und
  anschliessender Install-/Update-/Rollback-Abnahmelauf fuer dieses Produkt.
- Jede Arbeitsrunde endet mit aktuellem `BUILDLOG.md`/Handoff, sauberem Commit
  und Push auf den Arbeitsbranch. Keine Cross-Repo-Integration als erledigt
  markieren, bevor sie tatsaechlich live/CI-verifiziert wurde.
- Bewusst weiterhin nicht umgesetzt: MCP-App-UI, generischer Archiv-Entpacker,
  Cursor-Paginierung ueber die feste CSV/XLSX-Stichprobe hinaus, echte
  Mandanten-/Nutzertrennung und ein allgemeines SQLite-Schema-Migrationsframework.

## Verbindlicher License-/Distribution-Flow (Referenz)

Siehe [LICENSE-FLOW.md](LICENSE-FLOW.md) fÃ¼r den vollstÃ¤ndigen Fluss. Dieses
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

**Diese SHAs sind bewusst nicht als dauerhaft gÃ¼ltig zu behandeln** â€” vor
jeder kÃ¼nftigen Ã„nderung an diesem Produkt, die sich auf einen der obigen
VertrÃ¤ge stÃ¼tzt, erneut den aktuellen `main`-Stand prÃ¼fen.

## Offene Cross-Repo-Integrationsarbeit

### 1. `rheinagent-license`
- Neue Produktzeile `product_slug: "rheinagent-file-upload"` mit KanÃ¤len
  `stable`/`candidate` anlegen.
- Mindestens ein Test-Entitlement (`can_install: true, can_update: true`)
  fÃ¼r einen Test-Kunden erzeugen, um den Abnahmekriterien-Flow aus
  [LICENSE-FLOW.md](LICENSE-FLOW.md) durchspielen zu kÃ¶nnen.

### 2. `rheinagent-manager`
- `rheinagent-file-upload@1` zur vertrauten Package-v2-Profilliste
  hinzufÃ¼gen (Code-Review-pflichtig laut `PACKAGE-CONTRACT-V2.md`) â€” exakte
  Strategie/Service-IdentitÃ¤t fÃ¼r Windows noch offen, siehe
  [VERSIONING.md](VERSIONING.md) Zielstruktur.
- Entscheidung treffen: `installers={}` (Manager-owned Fresh-Bootstrap) oder
  klassischer Strategie-Pfad wie bei Mail/Knowledge.

### 3. `rheinagent-update-feed`
- Produkt-Manifest-Eintrag fÃ¼r `rheinagent-file-upload` anlegen, inkl.
  Kanal-Routing `stable`/`candidate`.

### 4. `rheinagent-audit`
- **Produkt-/Hub-Vertrag erledigt:** Das portable Profil
  `audit/rheinagent-file-upload-v1.json` und `src/lib/audit.ts` wurden gegen
  eine echte isolierte Hub-Instanz live abgenommen; siehe [AUDIT.md](AUDIT.md).
- Fuer einen spaeteren produktiven Kundenbetrieb bleibt nur die zentrale
  Service-Registrierung mit eigener Service-ID/Credential-Datei als
  Deployment-Schritt offen. Keine Audit-Credentials werden im Produkt-Image
  oder Repository eingebrannt.

## Plattform-Inkonsistenzen (beim Lesen der Referenz-Repos gefunden, nicht hier gelÃ¶st)

1. **Audit-Endpoint-Variablenname uneinheitlich**: `rheinagent-backoffice`
   nutzt `RA_AUDIT_ENDPOINT`, `rheinagent-knowledge-mcp` nutzt
   `RA_AUDIT_HUB_URL`. Dieses Produkt folgt `backoffice`. Eine
   plattformweite Vereinheitlichung wÃ¤re Sache von `rheinagent-audit`
   selbst (Dokumentation/SDK), nicht dieses Produkts.
2. Die Produktvorgabe fÃ¼r dieses Repo nannte `Codeelchi/rheinagent-mail-mcp`
   als Referenz-Repo â€” der tatsÃ¤chliche Name ist `Codeelchi/mailmcp`. FÃ¼r
   kÃ¼nftige Architektur-Checks den korrekten Namen verwenden.

## Innerhalb dieses Repos noch offen (nicht Cross-Repo, aber unerledigt)

- **Docker/Compose-Runtime-Gate:** Der fruehere reine Build-Smoke ist durch
  `docker-runtime-smoke` ersetzt. Er startet beide Container, faehrt
  Upload->Extraction->Duplicate->Knowledge-Handoff->Download, restartet beide
  Services und prueft anschliessend SQLite-/Datei-/Job-/Result-Persistenz. Der
  GitHub-Lauf ist die autoritative Container-Abnahme, da der lokale
  Windows-Testhost keinen Docker-Daemon hat.
- **Keine MCP-App-UI** fÃ¼r die aktuelle Tool-Menge (der frÃ¼here Prototyp mit
  anderen Tool-Namen wurde entfernt, siehe [BUILDLOG.md](../BUILDLOG.md)).
  UI ist laut Vorgabe optional â€” Business-Funktionen sind vollstÃ¤ndig ohne
  UI nutzbar; eine Wiederanbindung ist rein additiv und blockiert nichts.
  Bei Bedarf: `docs/ARCHITECTURE.md` Abschnitt "Runtime-Layer" fÃ¼r die
  Control-/Data-Plane-Trennung lesen, die eine UI respektieren mÃ¼sste
  (kein permissives CORS wieder einfÃ¼hren, siehe [SECURITY.md](SECURITY.md)).
- **Generischer Archiv-/Entpack-Processor nicht vorhanden** â€” nur `.docx`/
  `.xlsx` sind als eng zugeschnittene, bounded Ausnahme vom generellen
  Archive-Ablehnen implementiert (siehe [SECURITY.md](SECURITY.md)); ein
  echter `.zip`/`.tar`-Entpack-Processor brÃ¤uchte eigene, neu entworfene
  GrÃ¶ÃŸen-/Tiefenlimits.
- **`csv_inspect`/`xlsx_inspect` ohne Cursor-Paginierung** Ã¼ber die feste
  20-Zeilen-Stichprobe hinaus â€” bislang kein bekanntes reales BedÃ¼rfnis,
  siehe [PROCESSORS.md](PROCESSORS.md) Abschnitt "Chunking".
- **Kein Schema-Versions-/Migrationsframework** fÃ¼r die SQLite-Tabellen
  Ã¼ber `CREATE TABLE IF NOT EXISTS` hinaus â€” bei nur fÃ¼nf simplen
  Key-Value-Tabellen aktuell nicht nÃ¶tig, siehe
  [STATE-MIGRATION.md](STATE-MIGRATION.md).
- **Keine Mandanten-/Nutzertrennung** â€” einzige, geteilte Namespace pro
  Instanz (siehe [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md)).

## 2026-09-11 erledigt (vorher hier offen gelistet)

- **GitHub-Actions-CI-Workflow.** `.github/workflows/ci.yml` â€” `npm ci` +
  `npm run check` (Typecheck + alle 86 Tests) bei jedem Push/PR gegen
  `main`. Vorher lief `npm run check` nur manuell; jetzt automatisiert
  abgesichert.
- **`rheinagent_file_verify` (IntegritÃ¤ts-Check) + parametrisierbare
  Processor-Optionen.** Zwei weitere Features:
  1. **`rheinagent_file_verify`** (neu, 16. Tool) â€” liest eine Datei neu von
     der Platte, berechnet SHA-256 neu, vergleicht gegen den bei
     `upload_finalize` erfassten Wert. Die einzige Stelle, die IntegritÃ¤t
     nach der Annahme erneut prÃ¼ft (Disk-Korruption, Bit Rot auf einer
     langlebigen Pi-SD-Karte, manuelle Eingriffe in `data/files/` auÃŸerhalb
     dieses Produkts). Rein lesend; ein Mismatch ist **kein** `isError`
     (dieselbe Konvention wie `health_get`s `status: "degraded"`), sondern
     ein echter Befund im `matches`-Feld.
  2. **Processor-Optionen** â€” `process_prepare` nimmt jetzt ein optionales
     `options`-Objekt entgegen, gespeichert am `JobRecord`, unverÃ¤ndert an
     den Processor durchgereicht. `pdf_extract_text` nutzt das als erstes:
     `{"page": N}` extrahiert eine einzelne Seite statt des ganzen
     Dokuments â€” der Workaround fÃ¼r PDFs Ã¼ber der 64-KiB-Ergebnisgrenze.
     Ein unbekannter/falsch-geformter Wert scheitert als klarer Job-Fehler,
     nie als stiller Fallback.
  - Live end-to-end verifiziert: 2-seitige Test-PDF hochgeladen,
    `options: {"page": 2}` liefert exakt "Page Two Text", `options` rundet
    korrekt im `job_get`, `options: {"page": 99}` scheitert sauber als
    Job-Fehler mit klarer Meldung. `verify` gegen unverÃ¤nderte Datei
    (`matches: true`) und nach manuellem Byte-Tampering auf der Platte
    (`matches: false`) beide bestÃ¤tigt.
  - 17 neue automatisierte Tests (u. a. neues `test/jsonIndex.test.ts` â€”
    vorher das einzige `src/lib`-Modul ganz ohne dedizierte Tests, obwohl
    es der Persistenz-Layer unter jeder einzelnen Store-Operation ist) â€”
    jetzt **16 Tools, 86 automatisierte Tests**, `npm run check`
    fehlerfrei.
- **Filter fÃ¼r `file_list`/`job_list`, Mime-Category-Storage-Breakdown.**
  Weitere Runde funktionaler Verbesserungen:
  - `rheinagent_file_list` filterbar nach `mime_category` (exakt) und
    `filename_contains` (case-insensitive Substring) â€” Filterung lÃ¤uft in
    `listFilesPage()` vor der Pagination.
  - `rheinagent_file_job_list` zusÃ¤tzlich filterbar nach `state`
    (`prepared`/`completed`/`failed`) und `processor_id` â€” z. B. "alle
    fehlgeschlagenen Jobs" jetzt direkt abfragbar.
  - `rheinagent_file_health_get`s `storage` liefert zusÃ¤tzlich
    `by_mime_category` (Anzahl+Bytes pro Kategorie). **Live-Bug gefangen
    und gefixt:** `z.record(MimeCategorySchema, ...)` verlangt laut zod v4
    alle Enum-Werte als Keys â€” jede reale Instanz ohne Archiv-Upload schlug
    dadurch mit `Output validation error` fehl. Fix: `z.partialRecord(...)`.
    Neuer Regressionstest (`test/contracts.test.ts`) prÃ¼ft genau diesen Fall.
  - 5 neue automatisierte Tests â€” jetzt **69 automatisierte Tests**.
  - Live end-to-end verifiziert (inkl. des gefundenen und gefixten Bugs).
- **PDF/Image-Processoren, Prepare-Zeit-Mime-Check, Job-Listing, Storage-
  Stats, Rename.** FÃ¼nf funktionale Verbesserungen auf einmal umgesetzt:
  1. **PDF/Image-Processoren** â€” `pdf` und `image` waren erlaubte
     `mime_category`-Werte, aber ohne jeden Processor. Neu: `image_metadata`
     (PNG/JPEG-Dimensionen, per Hand geparst, keine Bildbibliothek),
     `pdf_metadata` + `pdf_extract_text` (via `pdfjs-dist`, bewusst ohne
     dessen native `@napi-rs/canvas`-Alternative `pdf-parse` â€” siehe
     [SECURITY.md](SECURITY.md)). Jetzt 5 Processor statt 2.
  2. **`process_prepare` prÃ¼ft `processor_id` gegen `mime_category`
     vorab** (`processorSupportsMimeCategory()`) â€” ein Mismatch (z. B.
     `text_stats` auf eine PDF) wird sofort mit klarer Fehlermeldung
     abgelehnt, statt erst nach einem echten `process_apply`-Versuch mit
     `state: "failed"` zu enden.
  3. **`rheinagent_file_job_list`** (neu) â€” Pendant zu `rheinagent_file_list`
     fÃ¼r Jobs, optional nach `file_id` gefiltert, cursor-paginiert. Vorher
     gab es keinen Weg zurÃ¼ck, wenn eine `job_id` verloren ging.
  4. **Storage-Stats in `rheinagent_file_health_get`** â€” `storage.file_count`/
     `total_bytes`/`staging_file_count`, damit ein Client den aktuellen
     Verbrauch kennt, ohne `rheinagent_file_list` komplett durchzupaginieren.
  5. **`rheinagent_file_rename`** (neu) â€” Ã¤ndert nur den Anzeigenamen; ein
     Rename, das die effektive `mime_category` Ã¤ndern wÃ¼rde (z. B. `.txt`
     â†’ `.pdf`), wird abgelehnt, damit die Extension/Magic-Byte-Konsistenz
     aus `upload_finalize` nicht im Nachhinein unterlaufen werden kann.
  - `capabilities.processors` liefert jetzt `{id, supported_mime_categories}`
    statt nur IDs â€” ein Client sieht direkt, welcher Processor zu welcher
    Datei passt, ohne Trial-and-Error.
  - Live end-to-end getestet: Upload von Text/PDF/PNG, Mismatch-Ablehnung
    bei `process_prepare`, alle 5 Processor gegen echte Dateien, `job_list`
    gefiltert nach `file_id`, Rename (erlaubt + abgelehnt), `health_get`-
    Storage-Stats, `capabilities_get`-Processor-Schema â€” alles wie erwartet.
  - 20 neue automatisierte Tests (`test/processors.test.ts` neu, 10 neue in
    `test/store.test.ts`) â€” jetzt **15 Tools, 5 Processor, 64 automatisierte
    Tests**, `npm run check` fehlerfrei.
  - Neue AbhÃ¤ngigkeit: `pdfjs-dist` (null eigene Laufzeit-AbhÃ¤ngigkeiten,
    siehe [SECURITY.md](SECURITY.md) zur Supply-Chain-BegrÃ¼ndung).
- **Cascade Delete, Staging-Reaper, CORS entfernt.** Drei Funde aus einer
  weiteren Codedurchsicht: (1) `delete_apply` lÃ¶schte Jobs/Ergebnisse der
  gelÃ¶schten Datei nicht mit â€” ein `text_uppercase`-Ergebnis (voller
  transformierter Dateiinhalt) blieb nach "LÃ¶schung" fÃ¼r immer abrufbar;
  jetzt kaskadierend entfernt (`cascadeDeleteJobsForFile()`). (2)
  Verwaiste Staging-Bytes bei PUT-ohne-Finalize wuchsen unbegrenzt an;
  neuer `sweepOrphanedStaging()`-Reaper (Start + alle 15 min). (3) `cors()`
  lief ohne Origin-EinschrÃ¤nkung, obwohl kein legitimer MCP-Client CORS
  braucht â€” komplett entfernt (`npm uninstall cors @types/cors`). Live
  verifiziert (Reaper: kÃ¼nstlich verwaister Eintrag + Neustart â†’ Log zeigt
  `removed_files:1,removed_entries:1`, danach nachweislich weg; CORS:
  `Origin`-Header liefert keinen `Access-Control-Allow-Origin` mehr). 4
  neue Tests â€” jetzt **48 automatisierte Tests**.
- **Tool-VertrÃ¤ge auditiert + LLM-ErklÃ¤rbarkeit umgesetzt.** Auf Anfrage
  ("stelle sicher, dass die Tools korrekte Beschreibungen/VertrÃ¤ge haben
  und recherchiere zum capabilities-Tool, um einem LLM die Funktionen zu
  erklÃ¤ren") alle 13 Tool-Beschreibungen/Contracts durchgesehen und drei
  echte LÃ¼cken gefunden + behoben:
  1. **Wire-Format war inkonsistent** â€” `FileRecordSchema`/`JobRecordSchema`/
     `DeleteTicketResultSchema` gaben `camelCase` zurÃ¼ck (direkt aus den
     internen `store.ts`-Records gespreadet), wÃ¤hrend jedes Tool-Input-Feld
     (`file_id`, `declared_size_bytes`, â€¦) und `UploadPrepareResultSchema`/
     `DownloadPrepareResultSchema` bereits `snake_case` waren. Jetzt
     durchgÃ¤ngig `snake_case` Ã¼ber einen neuen Mapping-Layer
     (`src/lib/wire.ts`: `toWireFile()`/`toWireJob()`/
     `toWireDeleteTicket()`) â€” bewusst als Breaking-Change vor jeder
     echten Kunden-Integration bereinigt, siehe
     [VERSIONING.md](VERSIONING.md) Schema-KompatibilitÃ¤t.
  2. **`file_id`/`job_id`/`upload_id`/`delete_token`-Eingaben waren nur
     lose `z.string()`** â€” eine falsche oder falsch-geformte ID scheiterte
     dadurch als generischer "internal error in `<tool>`" statt als
     saubere Validierungsmeldung. Jetzt per-Kind-Regex direkt im
     `inputSchema` (`FileIdField`/`JobIdField`/`UploadIdField`/
     `DeleteTokenField` in `src/lib/schemas.ts`, gebaut aus
     `idPattern()`/`ID_PREFIXES` in `src/lib/ids.ts`) â€” lehnt auch eine ID
     der falschen Art ab (z. B. `job_id` an `file_id` Ã¼bergeben), nicht
     nur "irgendein opaker String".
  3. **Kein Mechanismus, der einem LLM-Client das Workflow-Muster
     erklÃ¤rt.** Recherche in den MCP-SDK-Typen ergab: das spec-eigene
     `instructions`-Feld der `initialize`-Antwort
     (`ServerOptions.instructions` in `@modelcontextprotocol/server`) ist
     genau dafÃ¼r vorgesehen, wurde aber nie gesetzt. Jetzt gesetzt
     (`server.ts`, `SERVER_INSTRUCTIONS`) â€” eine kompakte Workflow-
     Kurzanleitung (Discover â†’ Upload â†’ Inspect â†’ Process â†’ Delete + "IDs
     sind opak"). Da nicht jeder MCP-Client `instructions` an das Modell
     durchreicht, trÃ¤gt `rheinagent_file_capabilities_get`s Antwort
     dieselbe Anleitung redundant als neues `usage`-Feld (Klartext-Content
     **und** `structuredContent`) â€” beide Quellen aus derselben Konstante
     `USAGE_STEPS` (`src/lib/capabilities.ts`), damit sie nicht
     auseinanderlaufen.
  - Live end-to-end verifiziert: `initialize`-Antwort trÃ¤gt `instructions`,
    `capabilities_get` trÃ¤gt `usage`, `upload_finalize`/`get` liefern
    `snake_case`, eine `job_id` als `file_id` und ein Path-Traversal-String
    scheitern beide als klare `Input validation error` statt als internal
    error. 9 neue automatisierte Tests (`test/contracts.test.ts`) fÃ¼r die
    ID-Feld-Validatoren und Wire-Mapper â€” jetzt **41 automatisierte Tests**,
    `npx tsc --noEmit` fehlerfrei. Tool-Anzahl unverÃ¤ndert bei 13 (reine
    Vertragsverbesserung, keine neuen Tools).
- **Bind-Host-Standard auf `127.0.0.1` geÃ¤ndert.** Beide Prozesse lauschten
  vorher ohne expliziten Host (`app.listen(PORT)`), was auf Node/Express
  `0.0.0.0` bedeutet â€” auf einem Homelab-Host im Tailnet/LAN ungeschÃ¼tzt
  erreichbar, da diese Version kein TLS/Auth auf HTTP-Ebene hat (siehe
  [SECURITY.md](SECURITY.md)). Neue Env-Var
  `RHEINAGENT_FILE_UPLOAD_BIND_HOST` (Default `127.0.0.1`), siehe
  [INSTALLATION.md](INSTALLATION.md).
- **Health/Doctor-Tool.** `rheinagent_file_health_get` implementiert das
  Health-Profil `rheinagent-file-upload-v1` aus [VERSIONING.md](VERSIONING.md):
  Data-Plane-Erreichbarkeit (`GET /healthz`, neu), Staging-/Files-
  Verzeichnis-Schreibbarkeit, und im `hub`-Audit-Modus Config-VollstÃ¤ndigkeit
  + `checkHubEndpointReachable()` als bewusst protokoll-loser
  Best-Effort-Netzwerkcheck (`src/lib/audit.ts`) â€” **kein** Beweis, dass der
  Write-Ahead-Vertrag selbst funktioniert. Live end-to-end getestet in drei
  ZustÃ¤nden (beide Planes up â†’ `ok`; Data Plane down â†’ `degraded`;
  `RA_AUDIT_MODE=hub` mit unerreichbarem Endpoint â†’ `degraded` +
  `hub_endpoint_reachable: false`, keine Credentials im Output). 6 neue
  automatisierte Tests (`test/audit.test.ts`, 2 neue in `test/store.test.ts`)
  â€” jetzt **13 Tools, 36 automatisierte Tests**, `npx tsc --noEmit` fehlerfrei.
  Auf Nutzerwunsch vor dem CI-Workflow priorisiert (siehe oben).
- **Download-Endpunkt fÃ¼r groÃŸe/binÃ¤re Dateien.** Neues Tool
  `rheinagent_file_download_prepare` (Control Plane) legt ein befristetes,
  wiederverwendbares `download_token` in der `downloads`-Tabelle von
  `data/meta/state.sqlite` an (15 min TTL, analog zu `PendingUpload`); `GET /download/:downloadToken`
  auf der Data Plane streamt die Bytes mit `Content-Disposition: attachment`.
  Verweigert Downloads fÃ¼r unbekannte/abgelaufene Token (`404`) und fÃ¼r
  bereits gelÃ¶schte/`pendingDelete`-Dateien (`410`/Prepare-Fehler). Live
  end-to-end getestet (Upload â†’ Finalize â†’ Download-Prepare â†’ GET, inkl.
  Token-Wiederverwendung und der beiden FehlerfÃ¤lle) und mit 4 neuen
  Store-Tests (`test/store.test.ts`) automatisiert abgesichert â€” jetzt
  **12 Tools**, 30 automatisierte Tests, `npx tsc --noEmit` fehlerfrei.
  `rheinagent_file_get`s Beschreibung verweist jetzt auf dieses Tool statt
  auf einen "future data-plane endpoint".
- **SDK-Migration auf Protokoll `2026-07-28`** â€” `@modelcontextprotocol/server`
  + `@modelcontextprotocol/node` (v2) statt des alten
  `@modelcontextprotocol/sdk` (max. `2025-11-25`). Legacy- und moderne
  Clients laufen Ã¼ber denselben `/mcp`-Endpunkt (`createMcpHandler`-Shim
  bestÃ¤tigt getestet gegen `2025-06-18`-Handshake und `2026-07-28`-stateless-
  Requests inkl. `Mcp-Method`/`Mcp-Name`-Headern).
- **`outputSchema` fÃ¼r alle 11 Tools** (`src/lib/schemas.ts`, zod â†’ JSON Schema).
- **Tool-Annotations** (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`).
- **Rate-Limiting** (`src/lib/rateLimit.ts`, pro Tool-Name, 3 Gewichtsklassen) â€” vorher 0 % umgesetzt, jetzt Pflichtanforderung der Spec erfÃ¼llt.
- **Pagination fÃ¼r `rheinagent_file_list`** (`cursor`/`next_cursor`, deterministische Sortierung).
- **Elicitation-BestÃ¤tigung vor `delete_apply`** (Multi-Round-Trip, `InputRequiredResult` â†’ `elicitation/create` â†’ `inputResponses`) â€” live End-to-End getestet (ohne BestÃ¤tigung â†’ `input_required`, mit BestÃ¤tigung â†’ tatsÃ¤chliche LÃ¶schung).
- **Strukturiertes Logging** (`src/lib/logging.ts`, stderr-JSON) statt `console.log` â€” bewusst **nicht** Ã¼ber die MCP-`notifications/message`-Utility, da diese laut Spec (SEP-2577) fÃ¼r `2026-07-28` deprecated ist.

**Noch nicht umgesetzt aus der ursprÃ¼nglichen Verbesserungsliste:**
Resource-Exposure (`resources/list`/`resources/read` fÃ¼r Dateien, zusÃ¤tzlich
zu den Tools) â€” bewusst zurÃ¼ckgestellt, da additiv und nicht
sicherheitskritisch.

## Naechster Schritt nach jedem obigen Punkt

Reihenfolge-Empfehlung, Stand 2026-09-12: (1) License/Manager/Update-Feed-
Registrierung fuer `rheinagent-file-upload`, inklusive Package-v2-Vertrag und
Kanal-Routing `stable`/`candidate`; (2) kompletter Manager-Abnahmelauf von
Entitlement -> geschuetztem Feed -> signiertem Paket -> Install/Health/Update/
Rollback; (3) produktive Audit-Service-Registrierung im Zielsystem als
Deployment-Schritt; (4) UI-Wiederanbindung nur optional. Audit-Hub-Live-Gate,
GitHub Docker-Runtime-Smoke, Forgejo-DinD-CI, lokaler kompilierter Vollflow,
SQLite-Persistenz, Document-Extraction, Duplikat-Erkennung und Knowledge-Handoff
sind abgeschlossen und duerfen nicht erneut als offene Kern-Gates gefuehrt
werden.
## 2026-09-12 - Manager/License/Update-Feed distribution integration

The Windows distribution contract is now implemented as Package-v2 profile `rheinagent-file-upload@1` with Manager-owned activation. The package carries only the reviewed bundled Node runtime (`dist/server.js`, `dist/dataplane.js`, `node.exe`), the Audit profile, the exact activation contract and runtime metadata. Customer license material is not written into the product runtime.

Distribution sources live under `packaging/distribution/`. Both GitHub and Forgejo have a dedicated `distribution` workflow that builds the Windows runtime, creates an ephemeral CI signing key for a smoke package, verifies Package-v2, enforces the 64 MiB Update Feed asset ceiling, and pins the production public trust anchor by SHA-256. The private production signing key is not present in this repository or CI artifacts.

Cross-repo development integration is implemented in RheinAgent License Service (entitlement/admin catalog), RheinAgent Manager 0.4.0-rc.7 (trusted product profile, fresh install, dual-plane health and rollback path) and RheinAgent Update Feed 0.4.1 (static product-to-Forgejo allowlist entry). Those source changes do not themselves publish a customer release. A production-signed Forgejo Candidate remains a separate release action through the established protected signing path.

Local distribution evidence before push: Windows runtime build PASS with Node 24, 11 processors, both `/healthz` planes PASS, `rheinagent_file_health_get` PASS, ephemeral-key Package-v2 build/verify PASS, resulting smoke package 50,783,276 bytes. Normal source gates remain `npm run check`, `npm run build` and `git diff --check` before commit.