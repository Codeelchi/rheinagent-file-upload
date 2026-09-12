## 2026-09-12 - Package-v2 Windows Distribution

Implemented the Manager-controlled Windows distribution contract for `rheinagent-file-upload@1`: bundled Node x64 runtime, dual control/data entry points, exact activation contract, public signing trust anchor, Package-v2 build/verify tooling, and GitHub/Forgejo distribution CI. Optional npm dependencies are excluded from the customer runtime to keep the package below the Update Feed 64-MiB asset ceiling without changing the 11-processor functional registry.

Local verification: `npm run check` 166 PASS + 1 Windows symlink privilege skip; runtime builder PASS; bundled Node processor-registry smoke reports 11; ephemeral-key Package-v2 build and verification PASS; resulting local test package 49,659,111 bytes; production public-key SHA-256 `1c4f5d5ad3313381b7d96d8782c853d950a87ad2f6a285b2c060d325d77e4a15`. The ephemeral private key and `.state/` artifacts were removed and are not part of the commit.
# Buildlog

Chronologisches Protokoll der Ã„nderungen an diesem MCP-Server. Neueste EintrÃ¤ge oben.

## 2026-09-12 - Audit-Hub-Vertrag produktseitig abgeschlossen und live abgenommen

- `src/lib/audit.ts` auf den aktuellen zentralen Audit-Hub-Vertrag aus
  `Codeelchi/rheinagent-audit@eb6765ed2c5e59ae9ae66021211e02fed66fae6a`
  ausgerichtet: semantische Actions, eindeutige Request-IDs, authentifizierter
  Service-Health und saubere Trennung zwischen Contract/Auth-Fehlern und echter
  Hub-Unverfuegbarkeit.
- Produkt-eigenes portables Profil `rheinagent-file-upload@1` fuer alle 18 MCP-
  Tools unter `audit/rheinagent-file-upload-v1.json`; Drift-Test gleicht Profil,
  Runtime-Mapping und tatsaechlich registrierte Tools exakt ab. Das Docker-Image
  liefert das Profil mit aus, aber keine Service-Credentials.
- Kritische Mutationen `upload_finalize`, `rename`, `process_apply` und
  `delete_apply` laufen jetzt write-ahead: durable INTENT muss vor der Mutation
  existieren; danach APPLY -> reale Business-Postcondition -> VERIFY -> RESULT.
  Nach bereits ausgefuehrter Mutation wird ein nachgelagerter Hub-Ausfall als
  `AuditIncompleteError` statt faelschlich als Business-Fehlschlag behandelt.
  Reale Postcondition-Fehler werden separat als
  `AuditBusinessVerificationError` sichtbar gemacht.
- Health/Doctor prueft im Hub-Modus getrennt `/healthz` sowie das
  authentifizierte `/v1/service/health`. Nicht-loopback HTTP bleibt standardmaessig
  gesperrt; ein bewusst geschuetzter interner Transport braucht explizit
  `RA_AUDIT_ALLOW_PRIVATE_HTTP=true`.
- Lokales Release-Gate nach der Umsetzung: **167 Tests / 166 PASS / 1 Windows-
  Symlink-Privilege-SKIP / 0 FAIL**, `npm run build` PASS und
  `git diff --check` PASS.
- Echte Live-Abnahme gegen eine isolierte lokale Instanz von
  `rheinagent-audit-core 0.2.0rc1`: Profil mit 18 Tools geladen, eigener
  Test-Service authentifiziert, Invocation akzeptiert, `file.upload.finalize`
  vollstaendig INTENT -> APPLY -> VERIFY -> RESULT, Negativtest mit ungueltiger
  Service-ID blockiert die Mutation vor INTENT, Hub-Verify=true,
  Operation=`complete/success`, offene Intents=0. Der produktive Mail-Hub auf
  Port 8766 blieb unberuehrt; isolierter Prozess, Temp-State und Test-Credential
  wurden danach entfernt.
- Damit ist das Audit-Hub-Live-Gate abgeschlossen. Naechstes zentrales Gate ist
  die License/Manager/Update-Feed-Integration und deren Install-/Update-/Rollback-
  Abnahme.
## 2026-09-12 - Forgejo Remote-DinD-CI vollstaendig verifiziert

- Der erste native Forgejo-Actions-Lauf auf Commit `6a71690` hat einen realen
  Infrastrukturunterschied sichtbar gemacht: der Node-Check lief erfolgreich,
  aber `docker-runtime-smoke` brach sofort ab, weil der Runner fuer
  `ubuntu-latest` ein `node:lts`-Job-Image ohne Docker-CLI startet. Das war
  kein Produktfehler.
- Commit `a808e5d49623cf6f5694f63c5672ed380b0e76d4` behebt diesen Forgejo-
  spezifischen Pfad mit `scripts/forgejo-runtime-smoke.sh` und
  `.forgejo/docker-compose.ci.yml`: aktueller Docker-CE-CLI plus Compose-
  Plugin aus dem offiziellen Docker-APT-Repository, dynamische Ermittlung des
  Remote-DinD-Gateways, CI-Bind der beiden Planes an `0.0.0.0`, getrennte
  Smoke-URLs und garantiertes `docker compose down -v` im Cleanup.
- Vor dem Push wurde der Aufbau realistisch verschachtelt getestet: ein
  `node:lts`-Job-Container lief gegen einen separaten Docker-in-Docker-Daemon
  29.8.0. Build beider Images, Health, Upload/Finalize, Extraction, Duplicate-
  Check, Knowledge-Handoff, Download, Restart und Persistenz-Verifikation
  liefen komplett durch (`NESTED_DIND_SMOKE_PASS`).
- Lokales Release-Gate blieb gruen: `npm run check` = 159 Tests / 158 PASS /
  1 privilegienbedingter Windows-Symlink-SKIP / 0 FAIL; `npm run build` und
  `git diff --check` PASS.
- GitHub Actions Run `34701497630` auf `a808e5d` ist SUCCESS.
- Der Feature-Branch im internen Forgejo-Repo wurde auf exakt denselben SHA
  synchronisiert. Nativer Forgejo `workflow_dispatch` Run `39` ist SUCCESS;
  Jobs `check` (Job 66) und `docker-runtime-smoke` (Job 67) sind beide gruen.
- Damit ist das zweite CI-Gate nicht mehr offen. Naechstes technisches Gate
  bleibt die Live-Verifikation des Audit-Hub-Write-Ahead-Vertrags; danach
  folgen License/Manager/Update-Feed-Integration.

## 2026-09-12 - Forgejo-Mirror und zweite CI vorbereitet

- Forgejo-Repository `rheinagent/rheinagent-file-upload` ist als interne
  Distribution-Kopie vorhanden; `main` bleibt auf dem GitHub-Main-Stand und
  der Arbeitsbranch `claude/mcp-server-continuation-fb3oq2` wurde bis zum
  aktuellen Feature-Stand synchronisiert.
- Additiver Forgejo-Workflow `.forgejo/workflows/ci.yml` hinzugefuegt. Er nutzt
  die Forgejo-Action-URLs und bildet dieselben beiden Gates ab wie GitHub:
  Node-22 Check/Build sowie echten Docker-Compose Runtime-Smoke mit
  Upload/Extraction/Knowledge-Handoff/Download und Restart-Persistenz.
- GitHub Actions fuer Commit `e5b09727733d8e5f065ded31b629356a43099784`
  ist vollstaendig gruen (Run `34698929363`). Damit ist der echte
  Docker/Compose-Flow auf GitHub CI bestaetigt.
- Der dedizierte Forgejo Actions Runner ist online. Als naechstes Gate wird
  derselbe Feature-Stand ueber Forgejos eigenen Git-HTTP-Pfad gepusht, damit
  der neue Forgejo-Workflow serverseitig ausgeloest und dort separat
  verifiziert wird.
## 2026-09-12 ? Compiled-Runtime-Pfade, Windows-Lifecycle und echter Runtime-Smoke

Bei der Abnahme des **kompilierten** Builds auf einem frischen Windows-Checkout
wurde eine L?cke gefunden, die die bisherigen Source-/Unit-Tests nicht abgedeckt
hatten: `store.ts` und `capabilities.ts` leiteten `data/` bzw. `package.json`
?ber eine feste Anzahl `..`-Segmente von `import.meta.dirname` ab. Das stimmt
im Source-Layout (`src/lib`) und im `tsx`-Betrieb, aber nicht mehr nach `tsc`
unter `dist/src/lib`; der Produktionsprozess suchte dadurch unter `dist/data`
bzw. `dist/package.json`.

- Neuer zentraler Resolver `src/lib/runtimePaths.ts`: Produktroot wird anhand
  des echten `package.json` mit `name: rheinagent-file-upload` nach oben
  aufgel?st und funktioniert identisch aus Source- und `dist`-Layout.
- Neue optionale Variable `RHEINAGENT_FILE_UPLOAD_DATA_DIR`. Ohne Override
  bleibt `<product-root>/data` der Default; relative Overrides werden bewusst
  gegen den Produktroot und nicht gegen `process.cwd()` aufgel?st. Compose
  setzt explizit `/app/data`.
- `PRODUCT_VERSION` liest `package.json` jetzt ?ber denselben Resolver.
- SQLite-Lifecycle erg?nzt: `closeAllDatabases()`/`closeDatabase()` und
  `closeStore()`. Control- und Data-Plane schlie?en bei `SIGINT`/`SIGTERM`
  zuerst den HTTP-Server und anschlie?end ihre SQLite-Handles. Das ist
  insbesondere f?r Windows-Upgrade/Rollback relevant, weil eine offene
  SQLite-Datei dort nicht gel?scht/ersetzt werden kann.
- Windows-Testportabilit?t korrigiert: SQLite-Tempdatenbanken werden vor
  Cleanup geschlossen; der echte Symlink-Test wird nur dann ?bersprungen,
  wenn der Windows-Account Symlink-Erzeugung mit `EPERM` verbietet. Linux-CI
  f?hrt den Test weiterhin real aus.
- Neuer `scripts/runtime-smoke.mjs` pr?ft den modernen MCP-HTTP-Pfad mit
  echten Requests: Health, Capabilities, Upload/PUT/Finalize, Extraction,
  Result, Duplicate-Erkennung, Knowledge-Handoff, Download und Verify. Eine
  zweite Phase verifiziert dieselben Datei-/Job-/Result-Daten nach Neustart.
- GitHub-CI-Job von reinem `docker build` auf `docker-runtime-smoke`
  erweitert: Compose startet beide Container, f?hrt den vollen Smoke,
  restartet beide Container und pr?ft danach die Persistenz im benannten
  Volume. Dadurch wird genau die Source-vs.-`dist`-Klasse k?nftig automatisch
  erkannt.

**Lokal verifiziert (Windows, ohne laufenden Docker-Daemon):** `npm run check`
= 159 Tests / 158 PASS / 1 SKIP (nur Symlink-Privilege) / 0 FAIL;
`npm run build` PASS; `git diff --check` PASS. Der kompilierte
`node dist/server.js` + `node dist/dataplane.js`-Flow lief mit separatem
Temp-Data-Dir vollst?ndig durch, inklusive Prozessneustart und Persistenz von
SQLite, Datei-Bytes, Job und Extraction-Result. `dist/data` wurde dabei nicht
angelegt.

**Noch offen in diesem Eintrag:** Der neue echte Compose-Runtime-Job muss nach
dem Push auf GitHub gr?n laufen; der lokale Windows-Host hat weiterhin keinen
laufenden Docker-Daemon. Audit-Hub-E2E bleibt ein separates Gate.

## 2026-09-11 â€” Versions-Bump `0.3.0`, README/HANDOFF auf aktuellen Stand

Abschluss der mehrteiligen Ausbaurunde zum File-Intake-/Analyse-Layer
(SQLite-Migration, 6 neue Extraction-Processoren, Chunking,
Duplikat-Erkennung, Knowledge-Handoff-Contract, Docker/Compose,
Health/Capabilities-Erweiterung â€” siehe die jeweiligen EintrÃ¤ge unten).

- **`package.json`/`package-lock.json` `0.2.0` â†’ `0.3.0`** (MINOR: echte
  Feature-Erweiterung + additive, aber bei strikter Validierung sichtbare
  Schema-Erweiterung, siehe `docs/VERSIONING.md` fÃ¼r die volle BegrÃ¼ndung).
  `PRODUCT_VERSION` (liest jetzt `package.json` zur Laufzeit) macht das
  automatisch Ã¼berall sichtbar, wo es referenziert wird â€” kein manuelles
  Nachziehen mehr nÃ¶tig auÃŸer in `docs/VERSIONING.md` selbst.
- **`README.md` komplett neu geschrieben** â€” der vorherige Stand nannte
  nur 5 Processor und 15 Tools und war seit mehreren Runden nicht mehr
  aktuell. Jetzt: alle 18 Tools, alle 11 Processor, Docker-Schnellstart,
  vollstÃ¤ndige Dokuverlinkung (`PROCESSORS.md`/`KNOWLEDGE-INTEGRATION.md`/
  `STATE-MIGRATION.md` waren dort noch gar nicht verlinkt).
- **`docs/HANDOFF.md`s "Einstieg fÃ¼r eine neue Session" Ã¼berarbeitet** â€”
  verwies noch auf einen lÃ¤ngst nicht mehr relevanten lokalen Pfad
  (`/home/Technowolf/mcp-ui-test` auf `berry`, aus einer Zeit vor diesem
  GitHub-Workflow) und einen veralteten Funktionsstand (16 Tools/86 Tests).
  Jetzt akkurat, inkl. ehrlicher Liste dessen, was in dieser Ausbaurunde
  bewusst **nicht** umgesetzt wurde (kein echter `docker build` gegen einen
  Daemon, keine Cursor-Paginierung fÃ¼r `csv_inspect`/`xlsx_inspect`, kein
  generischer Entpack-Processor, kein Schema-Migrationsframework, keine
  UI, keine Cross-Repo-Schritte).

`npm run check` weiterhin fehlerfrei (155 Tests, keine neuen â€” reine
Doku-/Versions-Pflege).

## 2026-09-11 â€” Health/Capabilities erweitert, Symlink-Sicherheitstests

Auftrag: Ausbau zum File-Intake-/Analyse-Layer, restliche kleinere Punkte
aus Phase 9/Definition-of-Done ("Health/Doctor erweitert", "Capabilities
aktuell", Security-Testabdeckung).

**`product_version`/`state_schema_version`** neu sowohl in
`rheinagent_file_capabilities_get` als auch `rheinagent_file_health_get`.
`PRODUCT_VERSION` liest `package.json#version` zur Laufzeit
(`src/lib/capabilities.ts`) statt eine dritte hartkodierte Kopie zu sein â€”
vorher stand `"0.2.0"` sowohl in `package.json` als auch separat in
`server.ts`s `McpServer`-IdentitÃ¤t; jetzt eine einzige Quelle.
`STATE_SCHEMA_VERSION` (aktuell `1`) macht das in `docs/VERSIONING.md`
("Schema-KompatibilitÃ¤t") schon beschriebene, bisher nirgends im Tool-
Output sichtbare Konzept erstmals abfragbar.

**`processor_registry.processor_count`, `jobs` (`prepared`/`completed`/
`failed`)** neu in `rheinagent_file_health_get` â€” `getJobStats()`
(`store.ts`, neu) zÃ¤hlt Jobs nach Zustand, ohne durch
`rheinagent_file_job_list` paginieren zu mÃ¼ssen. Ein Betreiber sieht so
direkt "stauen sich fehlgeschlagene Jobs an", ohne das selbst
zusammenzurechnen.

**3 neue Symlink-Sicherheitstests** (`test/security.test.ts`) fÃ¼r
`assertNotSymlink()` â€” bisher ganz ohne dedizierte Tests, obwohl es die
letzte Verteidigungslinie vor jedem Schreib-/Rename-Ziel in `store.ts`
ist (`finalizeFile`/`writeJobResult`). Echter Symlink angelegt, Ablehnung
verifiziert.

Live end-to-end Ã¼ber echten HTTP-Flow verifiziert:
`rheinagent_file_health_get` liefert korrekt `product_version: "0.2.0"`,
`state_schema_version: 1`, `processor_registry.processor_count: 11`,
`jobs: {prepared:0,completed:0,failed:0}`.

4 neue automatisierte Tests, 1 bestehender Test-Fixture-Body aktualisiert
â€” jetzt **155 automatisierte Tests**, `npm run check` fehlerfrei.

## 2026-09-11 â€” Docker/Produktionsrunntime

Auftrag: Ausbau zum File-Intake-/Analyse-Layer, Phase 8 (Production
Runtime) der priorisierten Reihenfolge.

**Build-Skripte** (`package.json`): `npm run build` (`tsc` â†’ `dist/`),
`npm run start`/`start:dataplane` (`node dist/server.js`/`dist/dataplane.js`
â€” reines `node`, kein `tsx`/`typescript` zur Laufzeit). Live verifiziert:
kompilierter Build lÃ¤uft standalone, `/mcp` antwortet korrekt.

**`Dockerfile`** (Multi-Stage) â€” Build-Stage mit `npm ci` (inkl.
Dev-Dependencies fÃ¼r `tsc`), Runtime-Stage ausschlieÃŸlich mit `npm ci
--omit=dev` (kein `tsx`/`typescript` im Runtime-Layer, wie gefordert),
`node:22-alpine`, non-root `rheinagent`-User.

**`docker-compose.yml`** â€” zwei Services (`file-control`/`file-data`) aus
demselben Image, gemeinsames benanntes Volume fÃ¼r `/app/data`. Bewusst
**kein** Supervisor-Prozess in einem gemeinsamen Container (Docker/Compose
ist bereits Prozessmanager, ein Supervisor wÃ¤re unnÃ¶tige zusÃ¤tzliche
AngriffsflÃ¤che) â€” mirrort stattdessen 1:1 die bestehende
Zwei-Prozess-Architektur. `network_mode: host` (Linux) statt Bridge +
Port-Publishing: **echter Bug gefunden und behoben**, bevor er in Produktion
hÃ¤tte auffallen kÃ¶nnen â€” `upload_url`/`download_url` sowie der interne
Health-Reachability-Check in `server.ts` waren fest auf `http://localhost:â€¦`
verdrahtet; unter Bridge-Networking hÃ¤tte das bedeutet, dass weder die
Control Plane die Data Plane erreicht noch ein externer MCP-Client die
zurÃ¼ckgegebene `upload_url` je auflÃ¶sen kÃ¶nnte. Fix: neue
`RHEINAGENT_FILE_UPLOAD_DATAPLANE_HOST`-Env-Var (Default weiterhin
`localhost`, keine VerhaltensÃ¤nderung im bisherigen Einzelprozess-Betrieb)
plus `network_mode: host` im Compose-Setup, damit `localhost` in beiden
Containern weiterhin dasselbe bedeutet wie im nicht-containerisierten
Betrieb â€” keine zweite Hostname-Konfiguration fÃ¼r intern vs. extern
beworbene URLs nÃ¶tig. SicherheitsmaÃŸnahmen: `read_only: true`,
`cap_drop: [ALL]`, `no-new-privileges`, Docker-`HEALTHCHECK`.

**Neues Control-Plane-`/healthz`** (`server.ts`, reine HTTP-Liveness,
kein MCP) â€” analog zum bereits vorhandenen Data-Plane-`/healthz`, damit
beide Planes einen einheitlichen, geschÃ¤ftslogikfreien Liveness-Endpunkt
fÃ¼r einen Container-Healthcheck haben (bewusst **nicht** dasselbe wie das
MCP-Tool `rheinagent_file_health_get`, das echte AbhÃ¤ngigkeitschecks macht).
Live verifiziert.

**CI-Docker-Build-Smoke** (`.github/workflows/ci.yml`, neuer Job
`docker-build-smoke`) â€” baut das Image bei jedem Push/PR, damit ein
kaputtes Dockerfile nicht erst bei einem echten Deploy auffÃ¤llt.

**Verifikationsstand, ehrlich benannt**: `docker build`/`docker compose up`
liefen **nicht** gegen einen echten Docker-Daemon (dieser Session stand
nur der `docker`-CLI-Client ohne laufenden Daemon zur VerfÃ¼gung) â€”
`docker compose config` validiert die Compose-Datei syntaktisch
fehlerfrei, mehr war lokal nicht mÃ¶glich. Der eigentliche Programmcode
(kompilierter Build via `node dist/server.js`) wurde auÃŸerhalb von Docker
live verifiziert. Der neue CI-Job deckt den echten `docker build` ab die
nÃ¤chsten Male, wenn dieser Branch pusht/einen PR Ã¶ffnet â€” bis dahin gilt
Docker/Compose als **implementiert, nicht per echtem Docker-Build
verifiziert**. `docs/INSTALLATION.md` benennt das explizit.

`npm run check` weiterhin fehlerfrei (152 Tests, keine neuen â€” reine
Infrastruktur-/Build-Ã„nderung, kein neuer Programmcode mit eigenem
Testbedarf auÃŸer dem bereits bestehenden `server.ts`-Testabdeckungsstand).

## 2026-09-11 â€” Knowledge-Handoff-Contract (`rheinagent_file_knowledge_handoff_prepare`, 18. Tool)

Auftrag: Ausbau zum File-Intake-/Analyse-Layer, Phase 6 (Knowledge-
Integration) der priorisierten Reihenfolge. Vorgabe: lose Kopplung, **kein**
Bypass von Knowledges eigenem Contribution-/Review-/Publish-Flow, keine
erfundenen `scope`/`classification`/`owner`-Werte.

**Erst recherchiert, dann gebaut.** Ein Subagent hat den tatsÃ¤chlichen
`main`-Stand von `Codeelchi/rheinagent-knowledge-mcp` gelesen (nicht nur
dessen Dokumentation): `knowledge_contribution_create` akzeptiert
**ausschlieÃŸlich** `{topic, department, scope, answers[], statements[]}`
â€” **kein** `title`/`content`/`tags`/`classification`-Feld existiert dort
bei Contribution-Erstellung Ã¼berhaupt (die Zielvorgabe fÃ¼r diese Session
ging von einem anderen, generischeren Schema aus â€” der reale Contract war
enger). `scope` muss zudem einer dem aufrufenden Principal bereits
gewÃ¤hrten Data-Scope entsprechen (`contributionScopeAllowed()` prÃ¼ft
`principal.dataScopes`), ist also strukturell nie frei erfindbar.

**`rheinagent_file_knowledge_handoff_prepare`** (neu, rein lesend) â€”
`src/lib/knowledgeHandoff.ts` baut aus einem `file_id` + optionalem
`extraction_job_id` (bereits abgeschlossener Extraction-Job derselben
Datei) einen Vorschlag in exakt der oben verifizierten Knowledge-Form:
- `topic`: Dateiname (Vorschlag, keine Erfindung).
- `department`/`scope`: **immer `null`** + Eintrag in `requires_user_input`
  â€” dieses Produkt hat keine Knowledge-Tenant-IdentitÃ¤t und kann diese
  Werte strukturell nicht kennen, geschweige denn raten.
- `answers`: immer `[]`.
- `statements`: aus dem `text`-Feld des Job-Ergebnisses, auf
  Absatzgrenzen gesplittet, hart auf Knowledges eigene Grenzen begrenzt
  (max. 100 Statements, je max. 5000 Zeichen) â€” der Aufrufer kann das
  Ergebnis ohne eigenes Nach-Chunking direkt an
  `knowledge_contribution_create` weiterreichen.
- `ready: true` bedeutet **nur** "trÃ¤gt echten Content", nie "sicher
  automatisch einreichbar" â€” es gibt keinen automatischen Ãœbergang zu
  Knowledges eigenen Tools.

Ruft Knowledge **nie selbst auf** â€” reine Vorschlagserstellung, die
Einreichung bleibt bewusst beim aufrufenden Client/Agenten mit dessen
eigener Knowledge-IdentitÃ¤t.

Live end-to-end Ã¼ber echten HTTP-Flow verifiziert: Upload einer
Zwei-Absatz-Textdatei â†’ ohne `extraction_job_id`: `ready: false`,
`statements: []`, erklÃ¤rende `warnings` â†’ mit vorher per `text_extract`
abgeschlossenem Job: `ready: true`, zwei `statements` exakt entsprechend
den beiden AbsÃ¤tzen, `department`/`scope` weiterhin `null`.

10 neue automatisierte Tests (`test/knowledgeHandoff.test.ts`: Chunking-
GrenzfÃ¤lle, nie erfundenes `department`/`scope`, Job-nicht-abgeschlossen-
Warnung, fehlendes `text`-Feld) â€” jetzt **18 Tools**, **152 automatisierte
Tests**, `npm run check` fehlerfrei. Neue Referenz-Doku
[KNOWLEDGE-INTEGRATION.md](docs/KNOWLEDGE-INTEGRATION.md) (vollstÃ¤ndige
Contract-Dokumentation inkl. der Recherche-Erkenntnisse).

## 2026-09-11 â€” `rheinagent_file_duplicate_check` (17. Tool)

Auftrag: Ausbau zum File-Intake-/Analyse-Layer, Phase 5 (Deduplikation)
der priorisierten Reihenfolge.

Neues, rein lesendes Tool `rheinagent_file_duplicate_check` â€” nutzt den
bei `upload_finalize` bereits erfassten SHA-256 (`findFilesBySha256()` in
`store.ts`, neu). Nimmt **genau eins** von `file_id` (findet jede andere
akzeptierte Datei mit identischem Inhalt, schlieÃŸt die Datei selbst aus)
oder `sha256` direkt entgegen (Duplicate-Check schon *vor* einem Upload).
LÃ¶scht/merged nie automatisch â€” reines Lookup, die Entscheidung bleibt
beim Aufrufer. Input-Validierung (`Sha256Field`, `DuplicateCheckInputSchema`
mit `.refine()` fÃ¼r "genau eins von beiden") als benannte, testbare
Schemas in `src/lib/schemas.ts`, demselben Muster wie die bestehenden
`*IdField`-Validatoren.

Live end-to-end Ã¼ber echten HTTP-Flow verifiziert (beide Prozesse
tatsÃ¤chlich gestartet): zwei Dateien mit identischem Inhalt hochgeladen,
`duplicate_check` per `file_id` findet die jeweils andere (nicht sich
selbst), per `sha256` direkt findet beide, eine dritte Datei mit
eindeutigem Inhalt liefert `duplicates: []`, beide/keins der Felder
scheitert klar als `Input validation error`.

8 neue automatisierte Tests (3 `store.test.ts`, 2 `contracts.test.ts` fÃ¼r
die Schemas) â€” jetzt **17 Tools**, **142 automatisierte Tests**, `npm run
check` fehlerfrei. `docs/ARCHITECTURE.md` (Tool-Tabelle),
`src/lib/capabilities.ts` (`usage`-Schritte) aktualisiert.

## 2026-09-11 â€” Chunking fÃ¼r `text_extract`/`docx_extract_text`

Auftrag: Ausbau zum File-Intake-/Analyse-Layer, Phase 4 (Chunking) der
priorisierten Reihenfolge â€” "auch ein 100-Seiten-Dokument muss vollstÃ¤ndig
analysierbar sein, ohne einen riesigen MCP-Response zu erzeugen".

`text_extract` und `docx_extract_text` (die beiden Processor fÃ¼r
unpaginierten FlieÃŸtext beliebiger LÃ¤nge) nehmen jetzt `options.offset`/
`options.limit` entgegen und liefern zusÃ¤tzlich `total_chars`/
`next_offset`. Ein Client liest ein beliebig langes Dokument vollstÃ¤ndig,
indem er wiederholt mit `offset = vorheriger next_offset` aufruft, bis
`next_offset: null`. Bewusst **kein** neues, formatÃ¼bergreifendes
Chunk-Entity/-Tool â€” `pdf_extract_text`s bereits vorhandenes
`options.page` und `xlsx_inspect`s zeilenbasierte Stichprobe lÃ¶sen
dasselbe Problem bereits mit dem fÃ¼r ihr Format passenderen Chunk-Begriff
(Seite bzw. Zeile statt Zeichenfenster); eine kÃ¼nstliche gemeinsame
Chunk-Abstraktion Ã¼ber alle Formate hÃ¤tte fÃ¼r keines davon wirklich
gepasst. `docx_extract_text` scannt intern jetzt bis zu 10 MiB Text (statt
vorher hart bei 64 KiB abzuschneiden), damit auch lange Dokumente
vollstÃ¤ndig chunk-weise erreichbar sind.

Live end-to-end verifiziert: ein ~145 000 Zeichen langer Text wurde per
wiederholtem `text_extract`-Aufruf (3 Chunks Ã  max. 64 KiB) exakt
byte-identisch wieder zusammengesetzt.

5 neue automatisierte Tests (Chunk-Walk Ã¼ber ein komplettes Dokument,
Offset-/Limit-Validierung, docx-Chunking) â€” jetzt **137 automatisierte
Tests**, `npm run check` fehlerfrei. `docs/PROCESSORS.md` um den
Chunking-Abschnitt ergÃ¤nzt (inkl. offen gelassenem nÃ¤chsten Schritt fÃ¼r
`csv_inspect`/`xlsx_inspect`, aktuell kein bekanntes reales BedÃ¼rfnis dafÃ¼r).

## 2026-09-11 â€” Document-Extraction-Processoren: CSV/JSON/Markdown/DOCX/XLSX

Auftrag: Ausbau zum File-Intake-/Analyse-Layer, Phase 3 (Document
Extraction) der priorisierten Reihenfolge.

**6 neue Processor, 2 neue `mime_category`-Erweiterungen.** Ziel:
`txt`/`md`/`csv`/`json`/`pdf`/`docx`/`xlsx` sinnvoll analysierbar, mit
harten Ressourcen-Limits, ohne neue Laufzeit-AbhÃ¤ngigkeit.

- **`text_extract`** (text) â€” bounded Volltext (64 KiB) + char/word/line-Counts,
  Pendant zu `pdf_extract_text` fÃ¼r reine Textdateien (vorher gab es nur
  `text_stats`, das keinen Inhalt zurÃ¼ckgab).
- **`markdown_structure`** (text, nur `.md`) â€” Headings, Link-Count,
  Code-Block-Count. Keine Markdown-AusfÃ¼hrung.
- **`csv_inspect`** (text, nur `.csv`) â€” hand-geschriebener RFC-4180-naher
  Tokenizer (Quoting, escaped `""`, eingebettete Delimiter/Newlines in
  Quotes), Delimiter-Auto-Erkennung (`,`/`;`/Tab) oder `options.delimiter`.
  Limits: max. 5000 gescannte Zeilen, max. 20 Beispielzeilen, 500 Zeichen
  pro Zelle.
- **`json_inspect`** (text, nur `.json`) â€” `root_type`/`keys`/`array_length`/
  bounded `sample`. **Sicherheitsdetail**: ein Bracket-Tiefen-Scan Ã¼ber den
  rohen Text lÃ¤uft *vor* `JSON.parse()` und lehnt > 64 Verschachtelungs-
  ebenen ab â€” verhindert, dass `JSON.parse`s eigener rekursiver Abstieg je
  mit absurd tiefem Input konfrontiert wird (Stack-Overflow-Risiko).
- **`docx_extract_text`** / **`xlsx_inspect`** (neue `mime_category: "office"`,
  nur `.docx`/`.xlsx`) â€” beide sind ZIP-Container (OOXML). Zwei neue Module
  dafÃ¼r, bewusst *keine* allgemeinen Unzip-/XML-Parser:
  - `src/lib/officeZip.ts`: hand-geschriebener ZIP-Central-Directory-Reader.
    Entpackt **nur** explizit angeforderte EintrÃ¤ge (nie alle), schreibt nie
    auf die Platte (Entry-Namen sind reine In-Memory-Map-Keys â€” Zip-Slip
    strukturell nicht anwendbar), begrenzt via Node's eigenem
    `zlib.inflateRawSync(..., {maxOutputLength})` pro Entry (20 MiB) und
    kumulativ (40 MiB), maximal 5000 Central-Directory-EintrÃ¤ge.
  - `src/lib/officeXml.ts`: enges Tag-/Regex-Scanning fÃ¼r die bekannten
    OOXML-Tags (`<w:t>`, `<sheet>`, `<si>`, `<row>`/`<c>`) statt eines
    echten XML-Parsers â€” kein XXE-Risiko, da nie ein `<!DOCTYPE>` oder eine
    externe Entity interpretiert wird (nur die 5 vordefinierten Entities +
    numerische Zeichenreferenzen).
  - **`sniffMimeCategory()` unterscheidet jetzt "echtes" OOXML von einem
    einfachen `.zip`**: ein auf `.docx` umbenanntes `.zip` besteht die
    Extension-PrÃ¼fung, scheitert aber an der Sniff/Declared-KonsistenzprÃ¼fung
    (`isOoxmlOfficeContainer()` prÃ¼ft `[Content_Types].xml` auf eine echte
    `wordprocessingml.document.main`/`spreadsheetml.sheet.main`-Deklaration).
  - `xlsx_inspect`: Shared-Strings bounded auf 20 000 EintrÃ¤ge
    (`shared_strings_truncated`-Flag statt unbegrenztem Array â€” explizite
    Verteidigung gegen eine "sharedStrings-Bombe"), Zeilen-/Spalten-Count
    primÃ¤r aus `<dimension>` (exakt, ohne Vollscan), sonst begrenzter
    Row-Scan (5000) mit `truncated`-Flag, `options.sheet` wÃ¤hlt ein
    bestimmtes Arbeitsblatt.
- **Kein neues `npm`-Package.** Alles mit Node-Bordmitteln (`zlib`,
  Regex/String-Scanning) â€” dieselbe Supply-Chain-Logik wie die
  `pdfjs-dist`-Entscheidung.

**Live-Sicherheitsverifikation** (nicht nur Unit-Tests, echte Angriffs-
payloads durchgespielt): Zip-Bomb (25 MiB hochkomprimierbare Nutzlast,
komprimiert auf wenige KB) sauber als Job-Fehler abgelehnt, *bevor* der
groÃŸe Buffer je materialisiert wird; Entry-Count-Bomb (6000 leere EintrÃ¤ge)
vor jedem Inflate-Versuch abgelehnt; sharedStrings-Bomb (50 000 deklarierte
EintrÃ¤ge) korrekt auf 20 000 gekappt statt Speicher zu erschÃ¶pfen; extrem
tiefes JSON (100 000 Ebenen) vor `JSON.parse()` abgelehnt; korruptes/nicht-
ZIP `.docx` sauber als Job-Fehler abgelehnt; ein plain `.zip`, umbenannt zu
`.docx`, wird beim Sniff korrekt als `archive` (nicht `office`) erkannt und
scheitert an der Upload-KonsistenzprÃ¼fung.

**VollstÃ¤ndiger Echt-HTTP-End-to-End-Test** (beide Prozesse tatsÃ¤chlich
gestartet, echte `curl`-Requests, kein reiner Unit-Test): ein via Python
gebautes `.docx` Ã¼ber `upload_prepare` â†’ Data-Plane-`PUT` â†’ `upload_finalize`
(korrekt als `mime_category: "office"` klassifiziert) â†’ `process_prepare`
(`docx_extract_text`) â†’ `process_apply` â†’ `result_get` â€” Ergebnis enthÃ¤lt
exakt den erwarteten extrahierten Text.

**Neue Test-Infrastruktur**: `test/testZip.ts` (kein `*.test.ts` â€” wird
nicht als eigene Testdatei ausgefÃ¼hrt) â€” ein minimaler, spec-valider
ZIP-Writer in reinem TypeScript (lokale + zentrale Header + EOCD, `store`/
`deflate`), damit Zip-/Office-Tests ohne externe BinÃ¤r-Fixtures oder
Python-AbhÃ¤ngigkeit auskommen, im Stil der bereits vorhandenen
Hand-Builder fÃ¼r PNG/JPEG in `test/processors.test.ts`.

**48 neue automatisierte Tests** (`test/officeZip.test.ts` 9,
`test/officeXml.test.ts` 10, `test/processors.test.ts` +25, `test/security.test.ts`
+4) â€” jetzt **11 Processor** (vorher 5), **16 Tools** (unverÃ¤ndert, reine
Processor-Erweiterung, kein neues Tool), **134 automatisierte Tests**,
`npm run check` fehlerfrei. Neue Referenz-Doku
[PROCESSORS.md](docs/PROCESSORS.md) (vollstÃ¤ndige Options-/Limit-Tabelle fÃ¼r
alle Processor). `docs/ARCHITECTURE.md`/`docs/SECURITY.md` aktualisiert.

## 2026-09-11 â€” Persistence-Migration JSON â†’ SQLite

Auftrag: Ausbau zum File-Intake-/Analyse-Layer (mehrteiliger Auftrag,
mehrere Runden). Erste Runde: Baseline-Hygiene (siehe vorheriger Eintrag,
CI) + Persistence-HÃ¤rtung, wie in der Zielvorgabe als Phase 2 priorisiert.

**Metadaten-Persistenz auf SQLite migriert.** `src/lib/jsonIndex.ts`
(whole-file-JSON, "last write wins" bei echter Gleichzeitigkeit zwischen
Control-/Data-Plane-Prozess, dokumentierte bekannte Grenze in
`SECURITY.md`) ersetzt durch `src/lib/sqliteIndex.ts` â€” `node:sqlite`
(eingebaut seit Node 22, keine neue Dependency, kein natives Addon, gleiche
Supply-Chain-Logik wie die `pdfjs-dist`-Entscheidung), WAL-Modus, echte
Read-Committed-Transaktionen pro Zeile statt Whole-File-Rewrite. Identischer
Ã¶ffentlicher Vertrag (`get`/`values`/`set`/`delete`) â€” `store.ts` musste nur
die Instanziierung der fÃ¼nf Tabellen Ã¤ndern (`uploads`/`files`/`jobs`/
`deletes`/`downloads`), kein anderer Aufrufer betroffen. Details/BegrÃ¼ndung:
`docs/STATE-MIGRATION.md` (neu).

Automatische, idempotente Migration bestehender `data/meta/*.json`-Dateien
beim Start (`migrateLegacyJsonMetadata()` in `ensureDirs()`) â€” importiert
nur in eine noch leere Zieltabelle, benennt die JSON-Quelle danach zu
`.migrated` um statt sie zu lÃ¶schen. Live end-to-end verifiziert: eine
handgeschriebene Alt-JSON-Datei wurde korrekt importiert, per direkter
SQLite-Abfrage bestÃ¤tigt, Quelldatei lag danach als `.migrated` vor.

`test/jsonIndex.test.ts` (9 Tests) entfernt (Modul ist tot, keine
verbleibenden Aufrufer), `test/sqliteIndex.test.ts` (neu, 10 Tests) deckt
denselben Verhaltensvertrag plus SQLite-spezifische FÃ¤lle (mehrere
Tabellen pro Datei unabhÃ¤ngig, Migration, kein Ãœberschreiben vorhandener
Zeilen) ab. Netto **87 automatisierte Tests**, `npm run check` fehlerfrei.
`docs/VERSIONING.md`/`docs/SECURITY.md`/`docs/ARCHITECTURE.md` auf den
neuen Stand gebracht; dabei auch den seit LÃ¤ngerem bestehenden
Versions-Drift behoben (`VERSIONING.md` nannte noch `0.1.0`,
`package.json` stand lÃ¤ngst auf `0.2.0`).

## 2026-09-11 â€” GitHub-Actions-CI-Workflow

Auftrag: letzte Session prÃ¼fen und weiterarbeiten. Repo war sauber (working
tree clean, lokal = `origin/claude/mcp-server-continuation-fb3oq2`), 86
Tests grÃ¼n, `tsc --noEmit` fehlerfrei â€” kein unfertiger Stand vorgefunden.
NÃ¤chster offener Punkt aus `HANDOFF.md` umgesetzt: der zuvor manuelle
`npm run check` lÃ¤uft jetzt automatisiert bei jedem Push/PR gegen `main`.

`.github/workflows/ci.yml` (neu) â€” `actions/checkout` + `actions/setup-node`
(Node 22, npm-Cache), dann `npm ci` und `npm run check` (Typecheck + alle
86 Tests). Keine funktionalen Code-Ã„nderungen an diesem Produkt selbst,
reine Absicherung des Release-Gates aus `VERSIONING.md`.

## 2026-09-11 â€” rheinagent_file_verify, Processor-Optionen, jsonIndex-Tests

Auftrag: weitere Verbesserungen/Features fÃ¼r den MCP Ã¼berlegen und
umsetzen. Vor der Feature-Arbeit erst eine echte QualitÃ¤tslÃ¼cke
geschlossen, dann zwei neue Features.

**0. `test/jsonIndex.test.ts` (neu).** `src/lib/jsonIndex.ts` â€” der
Persistenz-Layer unter jeder einzelnen `store.ts`-Operation â€” war das
letzte `src/lib`-Modul ganz ohne dedizierte Tests. 9 neue Tests: Basis-
Get/Set/Delete/Values, `mkdir(recursive)` beim ersten Write, Overwrite
lÃ¤sst andere EintrÃ¤ge unberÃ¼hrt, `delete()` auf nie existierende ID
persistiert keine leere Datei, zwei unabhÃ¤ngige `JsonIndex`-Instanzen auf
derselben Datei sehen sich gegenseitige Writes (simuliert die echte
Control-/Data-Plane-Prozesstrennung ohne zwei OS-Prozesse), Atomic-Rename
hinterlÃ¤sst keine `.tmp-*`-Leichen, kaputtes JSON auf der Platte wirft statt
still als leerer Index behandelt zu werden.

**1. `rheinagent_file_verify`** (neu, 16. Tool) â€” `verifyFile()` in
`store.ts` liest die Bytes einer Datei neu, berechnet SHA-256 neu,
vergleicht gegen den bei `upload_finalize` erfassten Wert.
`upload_finalize` prÃ¼ft IntegritÃ¤t nur einmalig beim Empfang; dieses Tool
ist die einzige Stelle, die das danach erneut tut (Disk-Korruption, Bit Rot
auf einer langlebigen Pi-SD-Karte, ein manueller Eingriff in
`data/files/`). Rein lesend, keine ZustandsÃ¤nderung. Bewusst **kein**
`isError` bei einem Mismatch â€” dieselbe Konvention wie `health_get`s
`status: "degraded"`: der Tool-Aufruf selbst war erfolgreich, `matches:
false` ist ein echter Befund, kein Fehler des Aufrufs.

**2. Processor-Optionen.** `rheinagent_file_process_prepare` nimmt jetzt
ein optionales `options`-Objekt (`z.record(z.string(), z.unknown())`),
gespeichert am `JobRecord` (`options?: Record<string, unknown>`, neues
optionales Feld, nur gesetzt wenn Ã¼bergeben) und bei `process_apply`
unverÃ¤ndert an `ProcessorContext.options` durchgereicht.
`pdf_extract_text` ist der erste Nutzer: `{"page": N}` (1-indexiert)
extrahiert eine einzelne Seite statt des gesamten Dokuments â€” der
naheliegende Workaround fÃ¼r PDFs, deren Volltext Ã¼ber der
64-KiB-Ergebnisgrenze liegt. `parsePageOption()` validiert Typ/Bereich
und wirft fÃ¼r alles UngÃ¼ltige einen klaren Fehler, statt still auf "ganzes
Dokument" oder "Seite 1" zurÃ¼ckzufallen; ein auÃŸerhalb des Seitenbereichs
liegender Wert scheitert ebenso klar nach dem Laden des Dokuments (dann ist
`doc.numPages` bekannt). Ergebnis trÃ¤gt jetzt zusÃ¤tzlich `page` (`null` =
ganzes Dokument).

**Getestet:** Live end-to-end gegen beide laufenden Prozesse â€” 2-seitige
Test-PDF hochgeladen, `process_prepare` mit `options: {"page": 2}` â†’
`process_apply` liefert exakt `"Page Two Text"` (nicht Seite 1), `options`
rundet korrekt in `job_get`s Antwort, `options: {"page": 99}` scheitert
sauber als Job-`state: "failed"` mit `"out of range"`-Meldung.
`rheinagent_file_verify` gegen unverÃ¤nderte Datei â†’ `matches: true`; nach
direktem Byte-AnhÃ¤ngen an die Datei auf der Platte (`data/files/<file_id>`)
â†’ `matches: false`, unterschiedliche `actual_sha256`, kein `isError`. 17
neue automatisierte Tests (9Ã— `jsonIndex`, 3Ã— `verifyFile`, 4Ã—
`pdf_extract_text`-Optionen, 1Ã— `createJob`-Options-Passthrough) â€” jetzt
**16 Tools, 86 automatisierte Tests, alle grÃ¼n**; `npm run check`
fehlerfrei.

**Doku aktualisiert:** `docs/ARCHITECTURE.md` (Processor-Optionen-Absatz,
`pdf_extract_text`-Tabellenzeile, `verify`-Absatz, Tool-Vertragstabelle,
Diagramm 15â†’16 Tools), `README.md`, `docs/VERSIONING.md`,
`docs/HANDOFF.md`.

## 2026-09-11 â€” Filter fÃ¼r file_list/job_list, Mime-Category-Storage-Breakdown

Auftrag: Funktionen des MCP weiter verbessern (Fortsetzung der letzten
Runde). Drei Erweiterungen:

**1. `rheinagent_file_list` filterbar.** Neue optionale Input-Felder
`mime_category` (exakt) und `filename_contains` (case-insensitive
Substring). `listFilesPage()` (`store.ts`) nimmt jetzt einen `FileListFilter`
als ersten Parameter; Filterung lÃ¤uft vor der Pagination, sodass
`cursor`/`next_cursor` Ã¼ber die gefilterte Menge laufen. Live verifiziert:
`filename_contains=invoice` findet `Invoice-2026-09.txt` case-insensitiv,
lÃ¤sst `receipt.txt` aus; `mime_category=text` liefert beide Textdateien.

**2. `rheinagent_file_job_list` filterbar.** Neue optionale Input-Felder
`state` (`prepared`/`completed`/`failed`) und `processor_id`, zusÃ¤tzlich
zum bestehenden `file_id`. `listJobsPage()` nimmt jetzt einen
`JobListFilter` (`fileId?`, `state?`, `processorId?`) statt nur `fileId?`
â€” Breaking Change der internen Signatur, alle Call-Sites (`server.ts`,
`test/store.test.ts`) angepasst. Live verifiziert: `state=completed`
findet nur den fertigen Job, `processor_id=text_uppercase` nur den
laufenden.

**3. `rheinagent_file_health_get`s `storage.by_mime_category`.**
`getStorageStats()` schlÃ¼sselt Anzahl+Bytes jetzt zusÃ¤tzlich pro
`mime_category` auf. **Live-Bug gefangen und gefixt:** Erste Version nutzte
`z.record(MimeCategorySchema, ...)` im `HealthSchema` â€” zod v4 verlangt bei
einem Record mit Enum-Key-Schema laut Spec **alle** Enum-Werte als
vorhandene Keys, nicht nur die tatsÃ¤chlich befÃ¼llten. Jede reale Instanz
(die z. B. nie eine `.zip` hochgeladen bekam) scheiterte dadurch mit
`Output validation error: ... storage.by_mime_category.archive: expected
object, received undefined` â€” live beim End-to-End-Test aufgefallen, sofort
auf `z.partialRecord(...)` korrigiert und erneut verifiziert. Neuer
Regressionstest in `test/contracts.test.ts` prÃ¼ft genau dieses Szenario
(nur `text` befÃ¼llt, `HealthSchema.safeParse` muss erfolgreich sein).

**Getestet:** Live end-to-end gegen beide laufenden Prozesse (Filter-
Kombinationen fÃ¼r beide List-Tools, `health_get` vor und nach dem
Schema-Fix). 5 neue automatisierte Tests (`test/store.test.ts`: 2Ã—
`listFilesPage`-Filter, 1Ã— `listJobsPage`-Filter, 1Ã—
`getStorageStats`-Breakdown; `test/contracts.test.ts`: 1Ã— Regressionstest)
â€” jetzt **69 automatisierte Tests, alle grÃ¼n**; `npm run check` fehlerfrei.

**Doku aktualisiert:** `docs/ARCHITECTURE.md` (Tool-Vertragstabelle,
List-Filter-Absatz, Health/Doctor-Absatz um `by_mime_category` ergÃ¤nzt),
`README.md`, `docs/HANDOFF.md`.

## 2026-09-11 â€” PDF/Image-Processoren, Job-Listing, Storage-Stats, Rename

Auftrag: weitere Verbesserungen fÃ¼r die *Funktionen* des MCP (nicht
Infrastruktur/Security wie die letzten Runden). FÃ¼nf vorgeschlagene Punkte
vollstÃ¤ndig umgesetzt.

**1. PDF/Image-Processoren.** `pdf`/`image` waren erlaubte
`mime_category`-Werte ohne jeden Processor â€” grÃ¶ÃŸte funktionale LÃ¼cke.

- `image_metadata` (`src/lib/processors.ts`): PNG-/JPEG-Dimensionen per
  Hand geparst (`parsePngDimensions()`: feste Offsets im IHDR-Chunk;
  `parseJpegDimensions()`: Marker-Scan bis zum SOF0â€“SOF15-Segment,
  DHT/JPG/DAC ausgenommen) â€” bewusst keine Bildbibliothek. Getestet gegen
  echte, in Node synthetisch erzeugte PNG/JPEG-Bytes: 64Ã—32 PNG und
  100Ã—50 JPEG korrekt erkannt.
- `pdf_metadata`/`pdf_extract_text`: neue AbhÃ¤ngigkeit `pdfjs-dist`
  (Mozillas PDF.js-Kern, null eigene Laufzeit-AbhÃ¤ngigkeiten) â€” bewusst
  **nicht** `pdf-parse`, das `@napi-rs/canvas` (natives Rust-Addon,
  unnÃ¶tig fÃ¼r Textextraktion, auf arm64 unerwÃ¼nscht) als Hard-Dependency
  zieht. LÃ¤uft ohne Worker (`workerSrc` nicht gesetzt â€” pdf.js erkennt
  Node und parst synchron im Hauptthread). Getestet gegen ein
  handgeschriebenes minimales PDF: Textextraktion und Metadaten
  (`page_count`, `pdf_format_version`) korrekt.
- Extrahierter Text ist auf 64 KiB gekappt (`PDF_TEXT_MAX_CHARS`, analog zu
  `INLINE_CONTENT_MAX_BYTES`) â€” das Ergebnis flieÃŸt Ã¼ber `result_get` durch
  MCP-JSON zurÃ¼ck, kein Freibrief fÃ¼r beliebig groÃŸe Payloads.

**2. Prepare-Zeit-Validierung `processor_id` vs. `mime_category`.**
Processor-Registry-Refactor: jeder Eintrag deklariert jetzt
`supportedMimeCategories` (`ProcessorEntry`, `processorSupportsMimeCategory()`).
`rheinagent_file_process_prepare` lehnt eine falsche Kombination (z. B.
`text_stats` gegen eine PDF) jetzt sofort ab, statt einen Job anzulegen,
der erst bei `process_apply` mit `state: "failed"` endet. Live verifiziert:
`text_stats` gegen eine hochgeladene PDF â†’ klare Fehlermeldung direkt bei
`process_prepare`, kein Job angelegt.

**3. `rheinagent_file_job_list`** (neu) â€” Pendant zu `rheinagent_file_list`
fÃ¼r Jobs (`listJobsPage()` in `store.ts`), optional nach `file_id`
gefiltert, cursor-paginiert nach demselben Muster. Live verifiziert:
gefiltert nach `file_id` liefert genau die zwei zu dieser Datei gehÃ¶rigen
Jobs.

**4. Storage-Stats in `rheinagent_file_health_get`.** Neues
`storage`-Feld (`file_count`, `total_bytes`, `staging_file_count`) aus
`getStorageStats()` â€” zÃ¤hlt auch `pendingDelete`-Dateien mit (Bytes bis
`delete_apply` noch belegt). Live verifiziert nach 3 Uploads:
`file_count: 3, total_bytes: 586`.

**5. `rheinagent_file_rename`** (neu) â€” Ã¤ndert nur `filename`; `file_id`,
Bytes, `sha256`, `mime_category` bleiben unverÃ¤ndert. `renameFile()` in
`store.ts` lehnt einen Rename ab, der die effektive `mime_category` Ã¤ndern
wÃ¼rde (z. B. `.txt` â†’ `.pdf`) â€” sonst lieÃŸe sich die Extension/Magic-Byte-
KonsistenzprÃ¼fung aus `upload_finalize` nachtrÃ¤glich unterlaufen. Live
verifiziert: Rename einer PDF auf einen neuen `.pdf`-Namen erfolgreich,
Rename derselben PDF auf einen `.txt`-Namen klar abgelehnt.

**ZusÃ¤tzlich:** `capabilities.processors` liefert jetzt
`{id, supported_mime_categories}` statt nur IDs (`listProcessorsWithCategories()`)
â€” ein Client sieht direkt, welcher Processor zu welcher Datei passt.
`USAGE_STEPS` entsprechend aktualisiert (job_list, rename erwÃ¤hnt).

**Getestet:** VollstÃ¤ndiger Live-E2E-Durchlauf gegen beide laufenden
Prozesse (Upload Text/PDF/PNG â†’ Mismatch-Ablehnung â†’ alle 5 Processor â†’
job_list â†’ rename erlaubt/abgelehnt â†’ health_get-Storage â†’ capabilities_get-
Schema). 20 neue automatisierte Tests (`test/processors.test.ts` neu, 10
neue in `test/store.test.ts`) â€” jetzt **15 Tools, 5 Processor, 64
automatisierte Tests, alle grÃ¼n**; `npm run check` fehlerfrei.

**Doku aktualisiert:** `docs/ARCHITECTURE.md` (Processor-Registry-Tabelle,
Tool-Vertragstabelle, Health/Doctor-Storage-Absatz, Rename-Absatz,
Diagramm 13â†’15 Tools), `docs/SECURITY.md` (neue Abschnitte
"AbhÃ¤ngigkeits-/Supply-Chain-Entscheidung: pdfjs-dist", Prepare-Zeit-
Mime-Check-ErgÃ¤nzung), `README.md`, `docs/VERSIONING.md`,
`docs/HANDOFF.md`.

## 2026-09-11 â€” Cascade Delete, Staging-Reaper, CORS entfernt

Fortsetzung des letzten Verbesserungsvorschlags â€” drei konkrete Funde aus
einer erneuten Codedurchsicht umgesetzt:

**1. LÃ¶schung war unvollstÃ¤ndig (Datenlebenszyklus-Bug).**
`rheinagent_file_delete_apply` entfernte nur Datei + `FileRecord`, nie die
zugehÃ¶rigen `JobRecord`s oder ihre gespeicherten Ergebnisse. Bei
`text_uppercase` ist das Ergebnis der komplette transformierte
Dateiinhalt â€” der blieb nach "LÃ¶schung" der Quelldatei unbegrenzt Ã¼ber
`rheinagent_file_result_get` abrufbar. Neue Funktion
`cascadeDeleteJobsForFile()` (`src/lib/store.ts`), in `applyDelete()`
eingehÃ¤ngt: entfernt jetzt jeden Job (und dessen Ergebnisdatei unter
`data/results/`) fÃ¼r die gelÃ¶schte Datei mit.

**2. Verwaiste Staging-Bytes (unbegrenztes Plattenwachstum).**
`getPendingUpload()` lÃ¶schte bei Ablauf (15 min TTL) nur den JSON-
Metadaten-Eintrag, nie die tatsÃ¤chlich gestagten Bytes unter
`data/staging/` â€” ein PUT ohne folgendes `upload_finalize` hinterlieÃŸ die
Datei fÃ¼r immer. Neue Funktion `sweepOrphanedStaging()` (`src/lib/store.ts`):
entfernt jede gestagte Datei ohne noch gÃ¼ltigen Pending-Upload-Eintrag und
rÃ¤umt abgelaufene Metadaten-EintrÃ¤ge proaktiv auf. Aufgerufen einmal beim
Start der Control Plane und danach alle 15 Minuten (`setInterval`, `unref()`d).

**3. CORS unnÃ¶tig offen.** `cors()` lief ohne Origin-EinschrÃ¤nkung auf der
Control Plane, obwohl kein legitimer MCP-Client (Agent-Prozess, curl,
Client-Bibliothek) je einen `Origin`-Header sendet â€” die einzige Wirkung
war AngriffsflÃ¤che fÃ¼r eine bÃ¶sartige Webseite im lokalen Browser des
Betreibers gegen `localhost:3901`. `cors`/`@types/cors` komplett aus
`package.json` entfernt (`npm uninstall`).

**Getestet:**
- Live end-to-end: vollstÃ¤ndiger Uploadâ†’Process(`text_uppercase`)â†’
  `result_get`(zeigt Inhalt)â†’Delete-Flow bestÃ¤tigt Cascade-Verhalten am
  Store-Layer (die MCP-Elicitation-BestÃ¤tigung selbst lieÃŸ sich Ã¼ber
  reines Raw-curl ohne `initialize`-Handshake nicht auslÃ¶sen â€” unabhÃ¤ngig
  von dieser Ã„nderung, bereits vorher bekanntes Test-Tooling-Detail).
  Reaper live verifiziert: kÃ¼nstlich verwaiste Staging-Datei + abgelaufener
  Metadaten-Eintrag angelegt, Control Plane neu gestartet â†’
  `"staging sweep","removed_files":1,"removed_entries":1"` geloggt, beides
  danach nachweislich weg.
- CORS live verifiziert: `curl` mit `Origin: http://evil.example` gegen
  `/mcp` liefert keinen `Access-Control-Allow-Origin`-Header mehr (vorher
  reflektiert).
- 4 neue automatisierte Tests in `test/store.test.ts` (2Ã— Cascade-Delete,
  2Ã— Staging-Reaper) â€” jetzt **48 automatisierte Tests**, `npm run check`
  fehlerfrei.

**Doku aktualisiert:** `docs/SECURITY.md` (neue Abschnitte "Kein CORS
(bewusst)", "VollstÃ¤ndigkeit der LÃ¶schung", "Keine verwaisten Upload-
Bytes"), `docs/ARCHITECTURE.md` (Read/Prepare/Apply/Verify-Tabelle,
Staging/Quarantine-Abschnitt).

## 2026-09-11 â€” Tool-Vertrags-Audit + LLM-ErklÃ¤rbarkeit + Workflow-Script

Auftrag: sicherstellen, dass alle Tools korrekte Beschreibungen/VertrÃ¤ge
haben, recherchieren, wie ein `capabilities`-Tool einem LLM die Funktionen
erklÃ¤ren sollte (und ob das umgesetzt werden soll), und weitere
Verbesserungen fÃ¼r MCP + Workflow vorschlagen.

**Vertrags-Audit-Ergebnis (alle 13 Tools durchgesehen):** Annotations
(`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`) und
Rate-Limit-Klassen passten bereits konsistent zum tatsÃ¤chlichen Verhalten.
Zwei echte LÃ¼cken gefunden und behoben:

1. **Wire-Format-Inkonsistenz.** `FileRecordSchema`/`JobRecordSchema`/
   `DeleteTicketResultSchema` gaben bisher `camelCase` zurÃ¼ck (direkt aus
   den internen `store.ts`-Records gespreadet), obwohl jedes Tool-Input-
   Feld und `UploadPrepareResultSchema`/`DownloadPrepareResultSchema`
   bereits `snake_case` waren â€” zwei Konventionen im selben Ã¶ffentlichen
   Vertrag. Neuer Mapping-Layer `src/lib/wire.ts`
   (`toWireFile()`/`toWireJob()`/`toWireDeleteTicket()`); jeder
   `structuredContent`-RÃ¼ckgabewert lÃ¤uft jetzt dadurch. Bewusst als
   Breaking-Change vor jeder echten Kunden-Integration bereinigt (siehe
   `docs/VERSIONING.md` Schema-KompatibilitÃ¤t â€” genau der richtige
   Zeitpunkt dafÃ¼r).
2. **ID-Eingaben nur lose typisiert.** `file_id`/`job_id`/`upload_id`/
   `delete_token` waren `z.string()` ohne FormprÃ¼fung â€” eine falsche ID
   scheiterte dadurch als generischer "internal error in `<tool>`" statt
   als klare Validierungsmeldung (Ursache: `assertOpaqueId()` wirft erst
   tief in `store.ts`). Neue Per-Kind-Feldschemas `FileIdField`/
   `JobIdField`/`UploadIdField`/`DeleteTokenField` (`src/lib/schemas.ts`,
   gebaut aus neu exportiertem `idPattern()`/`ID_PREFIXES` in
   `src/lib/ids.ts`) â€” lehnen jetzt auch eine ID der falschen Art ab (z. B.
   ein `job_id`-Wert an `file_id` Ã¼bergeben), nicht nur beliebige Strings.

**Recherche â€žcapabilities-Tool fÃ¼r LLM-ErklÃ¤rbarkeitâ€œ:** Im MCP-SDK
(`@modelcontextprotocol/server`) gefunden: `ServerOptions.instructions`
(String, Teil der `initialize`-Antwort) ist laut Typdefinition genau dafÃ¼r
vorgesehen â€” "Optional instructions describing how to use the server and
its features" â€” wurde von diesem Produkt aber nie gesetzt. Das ist der
spec-eigene Mechanismus, nicht das selbstgebaute
`rheinagent_file_capabilities_get`. Umgesetzt:
- `server.ts`: `new McpServer(serverInfo, { instructions: SERVER_INSTRUCTIONS })`
  â€” kompakte Workflow-Kurzanleitung (Discover â†’ Upload â†’ Inspect â†’ Process
  â†’ Delete, IDs sind opak), erreicht das Modell einmal pro Session ohne
  Tool-Call.
- Da nicht jeder MCP-Client `instructions` an das Modell durchreicht:
  redundant auch als neues `usage`-Feld in
  `rheinagent_file_capabilities_get`s Antwort (Klartext-Content **und**
  `structuredContent`), da viele Agent-Frameworks dieses Tool ohnehin frÃ¼h
  aufrufen. Beide Quellen kommen aus derselben Konstante `USAGE_STEPS`
  (`src/lib/capabilities.ts`), damit sie nicht auseinanderlaufen.
- ZusÃ¤tzlich `capabilities.limits.rate_limit_window_ms`/
  `rate_limits_per_window` ergÃ¤nzt (aus `src/lib/rateLimit.ts` exportiert)
  â€” ein Client kennt sein Pacing-Budget vorab statt erst Ã¼ber einen
  `rate limit exceeded`-Fehler.

**Workflow-Verbesserung:** neues `npm run check` (= `tsc --noEmit` + `npm
test`) bÃ¼ndelt das komplette `docs/VERSIONING.md`-Release-Gate in einem
Befehl statt zwei manuell zu merkenden Kommandos.

**Getestet:** Live end-to-end â€” `initialize`-Antwort trÃ¤gt `instructions`,
`capabilities_get` trÃ¤gt `usage` + Rate-Limit-Felder, `upload_finalize`/
`get` liefern durchgÃ¤ngig `snake_case`, eine `job_id` als `file_id` und ein
Path-Traversal-String scheitern beide als klare `Input validation error`
statt internal error. 12 neue automatisierte Tests (`test/contracts.test.ts`
fÃ¼r ID-Felder + Wire-Mapper, `test/capabilities.test.ts` â€” vorher komplett
ungetestetes Modul) â€” jetzt **44 automatisierte Tests**, `npm run check`
fehlerfrei. Tool-Anzahl unverÃ¤ndert bei 13 (reine Vertragsverbesserung).

**Doku aktualisiert:** `docs/ARCHITECTURE.md` (neue AbsÃ¤tze: Wire-
Konvention, ID-Validierung, Instructions/Usage-Pattern, Rate-Limit-Feld),
`README.md`, `docs/HANDOFF.md`, `docs/VERSIONING.md` (Release-Gate nutzt
jetzt `npm run check`).

## 2026-09-11 â€” Bind-Host-Fix (loopback-only) + Health/Doctor-Tool

Auf Anfrage: Verbesserungen fÃ¼r den MCP durchdacht (Bind-Host-LÃ¼cke,
CI-Workflow, Health/Doctor-Tool, TestlÃ¼cken in `audit.ts`/`jsonIndex.ts`,
Docker-Setup). Nutzer hat CI fÃ¼r diese Runde zurÃ¼ckgestellt und
Health/Doctor priorisiert.

**Sicherheitsfix â€” Bind-Host-Standard:**
- `server.ts` und `dataplane.ts` riefen `app.listen(PORT, ...)` bisher ohne
  Host auf, was bei Express/Node `0.0.0.0` bedeutet â€” auf `berry` (Pi im
  Tailnet/LAN) waren beide HTTP-Planes damit netzwerkweit erreichbar, obwohl
  diese Version laut `docs/SECURITY.md` bewusst kein TLS/Auth auf
  HTTP-Ebene hat.
- Neue Env-Var `RHEINAGENT_FILE_UPLOAD_BIND_HOST`, Default `127.0.0.1`, fÃ¼r
  beide Prozesse. Verifiziert per `ss -ltnp`: vorher `*:3902` (wildcard),
  danach `127.0.0.1:3901`/`127.0.0.1:3902`.

**Neues Tool: `rheinagent_file_health_get`** (Health-Profil
`rheinagent-file-upload-v1`, Konzept aus `docs/VERSIONING.md` erstmals
implementiert):
- `control_plane_reachable` (trivial `true`), `data_plane_reachable` (neuer
  `GET /healthz`-Endpunkt auf der Data Plane, 2 s Timeout),
  `staging_dir_writable`/`files_dir_writable` (`fs.access(dir, W_OK)`,
  hinterlÃ¤sst keine Probe-Datei).
- Im `hub`-Audit-Modus zusÃ¤tzlich: `endpoint_configured`/
  `service_id_configured`/`credential_path_configured` (nur ob gesetzt, nie
  die Werte) sowie `hub_endpoint_reachable` â€” neue Funktion
  `checkHubEndpointReachable()` in `src/lib/audit.ts`, bewusst ein
  protokoll-loser reiner Netzwerk-Reachability-Check (kein Credential im
  Request), **kein** Ersatz fÃ¼r die weiterhin offene Audit-Hub-Live-
  Verifikation des Write-Ahead-Vertrags selbst.
- `status: "ok"|"degraded"` â€” `degraded` sobald irgendeine EinzelprÃ¼fung
  negativ ausfÃ¤llt.

**Getestet:**
- Live end-to-end in drei ZustÃ¤nden: beide Planes hoch â†’ `status: "ok"`,
  `data_plane_reachable: true`; Data Plane gestoppt â†’ `status: "degraded"`,
  `data_plane_reachable: false`; `RA_AUDIT_MODE=hub` mit absichtlich
  unerreichbarem Endpoint (`http://127.0.0.1:9999`) â†’ `status: "degraded"`,
  `hub_endpoint_reachable: false`, Config-Flags korrekt `true`, keine
  Credentials im Output.
- 6 neue automatisierte Tests: `test/audit.test.ts` (neu, 5 Tests fÃ¼r
  `loadAuditConfig`/`checkHubEndpointReachable` inkl. env-Isolation) + 1
  neuer Test in `test/store.test.ts` fÃ¼r die Verzeichnis-Schreibbarkeits-
  Helfer. Insgesamt jetzt **13 Tools, 36 automatisierte Tests, alle grÃ¼n**;
  `npx tsc --noEmit` fehlerfrei.

**Doku aktualisiert:** `docs/ARCHITECTURE.md` (Bind-Host-Absatz + neue
"Health / Doctor"-Sektion + Tool-Vertragstabelle + Diagramm-Update auf 13
Tools), `docs/SECURITY.md`, `docs/AUDIT.md` (Allowlist-Tabelle),
`docs/VERSIONING.md` (Health/Doctor-Konzept als implementiert markiert,
Release-Gate-Toolzahl), `docs/INSTALLATION.md` (neue Env-Var, Doctor-
Abschnitt), `README.md`, `docs/HANDOFF.md` (beide Punkte aus "offen"
entfernt, CI-ZurÃ¼ckstellung dokumentiert, PrioritÃ¤tenliste neu sortiert).

## 2026-09-11 â€” Download-Endpunkt fÃ¼r groÃŸe/binÃ¤re Dateien

NÃ¤chster unblockierter Punkt aus `docs/HANDOFF.md`s PrioritÃ¤tenliste:
Audit-Hub-Live-Verifikation (Punkt 1) hÃ¤ngt an einer Cross-Repo-
Registrierung in `rheinagent-audit`, die laut HANDOFF ausdrÃ¼cklich nicht in
diesem Repo erledigt wird, und diese Session hatte keinen konfigurierten
Zugriff auf eine laufende Hub-Instanz. Stattdessen umgesetzt: der bisher
fehlende Download-Pfad fÃ¼r Dateien, die `rheinagent_file_get` nicht inline
liefert (alles Ã¼ber 64 KiB bzw. nicht-Text).

**Neu:**
- `newDownloadToken()` (`src/lib/ids.ts`, PrÃ¤fix `dl_`).
- `DownloadTicket` + `createDownloadTicket()`/`getDownloadTicket()`
  (`src/lib/store.ts`, `data/meta/downloads.json`) â€” 15 min TTL, bewusst
  **wiederverwendbar** innerhalb der TTL (anders als der Einweg-
  `delete_token`), weil ein `GET` laut `readOnlyHint`-Konvention idempotent
  sein muss. `createDownloadTicket` weist Dateien ab, die nicht existieren
  oder `pendingDelete` sind.
- Tool `rheinagent_file_download_prepare` (Control Plane, `write`-
  Gewichtsklasse wie `upload_prepare`/`delete_prepare`) liefert
  `download_token` + `download_url` gegen die Data Plane.
- `GET /download/:downloadToken` (Data Plane, `dataplane.ts`) lÃ¶st das
  Token auf, liest ausschlieÃŸlich Ã¼ber `filePath()` (opake, bereits
  validierte Pfade unter `data/files/`) und streamt mit
  `Content-Disposition: attachment`. Unbekannter/abgelaufener Token â†’ `404`,
  inzwischen gelÃ¶schte Datei â†’ `410`.
- `DownloadPrepareResultSchema` (`src/lib/schemas.ts`).

**Getestet:**
- Live end-to-end gegen beide laufenden Prozesse (Control Plane Port 3901,
  Data Plane Port 3902) per direktem JSON-RPC + HTTP: Upload â†’ Finalize â†’
  Download-Prepare â†’ GET, inkl. Token-Wiederverwendung (zweiter GET mit
  demselben Token â†’ `200`), unbekannter Token (`404`) und
  Download-Prepare-Ablehnung fÃ¼r eine `pendingDelete`-Datei.
- 4 neue automatisierte Tests in `test/store.test.ts` (Round-Trip,
  unbekanntes Token, unbekannte `file_id`, `pendingDelete`-Ablehnung) â€”
  insgesamt jetzt **30 Tests, alle grÃ¼n**; `npx tsc --noEmit` fehlerfrei.

**Doku aktualisiert:** `docs/ARCHITECTURE.md` (neue "Download"-Sektion +
Tool-Vertragstabelle), `docs/SECURITY.md` (Trust-Grenzen + "bekannte
Grenzen"), `docs/AUDIT.md` (Allowlist-Tabelle), `docs/VERSIONING.md`
(Release-Gate: 11â†’12 Tools), `README.md`, `docs/HANDOFF.md` (Download-Punkt
aus "offen" entfernt, PrioritÃ¤tenliste neu sortiert, Hinweis auf fehlenden
Audit-Hub-Zugriff in dieser Session ergÃ¤nzt).

## 2026-09-11 â€” Echte Protokoll-2026-07-28-KonformitÃ¤t + MCP-Spec-NachrÃ¼stung

Nach Abgleich mit der offiziellen MCP-Dokumentation festgestellt: Das bis
eben genutzte `@modelcontextprotocol/sdk@1.30.0` unterstÃ¼tzte nur bis
Protokoll `2025-11-25` â€” das im Produktbriefing geforderte Zielprotokoll
`2026-07-28` wurde trotz `capabilities_get`-Angabe technisch nicht
eingehalten. Komplettumstellung auf die neue v2-Paketlinie plus NachrÃ¼stung
mehrerer von der Spec verlangter/empfohlener Mechanismen, die vorher fehlten.

**SDK-Migration:**
- `@modelcontextprotocol/sdk` entfernt, ersetzt durch `@modelcontextprotocol/server`
  + `@modelcontextprotocol/node` (v2.0.0)
- `createMcpHandler()` + `toNodeHandler()` bedienen Legacy- (`initialize`-Handshake,
  z. B. `2025-06-18`) und moderne (`2026-07-28`, stateless, `_meta`-basiert)
  Clients Ã¼ber denselben `/mcp`-Endpunkt
- Alle `registerTool`-Aufrufe auf zod-Objekt-Schemas (`inputSchema`/`outputSchema`)
  statt Raw-Shapes umgestellt; `outputSchema` pro Tool neu (`src/lib/schemas.ts`)
  macht `structuredContent` clientseitig validierbar
- Tool-`annotations` (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`)
  fÃ¼r alle 11 Tools ergÃ¤nzt

**Neue, parallel per Fork gebaute Module** (unabhÃ¤ngig, dann selbst integriert):
- `src/lib/rateLimit.ts` â€” Rate-Limiting pro Tool-Name, 3 Gewichtsklassen
  (read/write/critical), env-konfigurierbar. Vorher: 0 % Rate-Limiting trotz
  Spec-Pflicht ("servers MUST rate limit tool invocations").
- `src/lib/logging.ts` â€” strukturiertes stderr-JSON-Logging statt `console.log`.
  Wichtiger Fund dabei: die MCP-`notifications/message`-Logging-Utility ist in
  `2026-07-28` deprecated (SEP-2577) â€” bewusst nicht darauf gesetzt.

**Selbst umgesetzt:**
- Pagination fÃ¼r `rheinagent_file_list` (`cursor`/`next_cursor`, deterministische
  Sortierung nach `createdAt`+`fileId`) â€” verhindert unbegrenztes Wachstum
  durch MCP-JSON bei vielen Dateien
- Elicitation-BestÃ¤tigung vor `rheinagent_file_delete_apply`: ohne akzeptierte
  `confirm: true`-Antwort liefert das Tool `InputRequiredResult`
  (`resultType: "input_required"`), die Datei bleibt unverÃ¤ndert. Erster
  echter Multi-Round-Trip-Flow in diesem Produkt.

**Getestet (end-to-end, nicht nur Unit-Tests):**
- Legacy-`initialize` (`2025-06-18`) weiterhin funktionsfÃ¤hig
- Moderner stateless `2026-07-28`-Request (`_meta`, `Mcp-Method`/`Mcp-Name`-Header)
  fÃ¼r `tools/list` und `tools/call` â€” inkl. automatisch generierter
  `outputSchema`/`annotations` in der `tools/list`-Antwort
  (`resultType: "complete"`, `cacheScope`)
- VollstÃ¤ndiger Upload-Flow unter dem neuen Protokoll
- Delete-Flow inkl. `MissingRequiredClientCapabilityError` (-32021) wenn
  `elicitation`-Capability fehlt, `input_required` ohne BestÃ¤tigung, echte
  LÃ¶schung erst nach akzeptierter BestÃ¤tigung
- Pagination (3 Dateien hochgeladen, `limit=2` â†’ korrekte 2 Seiten mit/ohne `next_cursor`)
- 26 automatisierte Tests (13 bestehend + 5 Rate-Limit + 8 Logging), alle grÃ¼n;
  `npx tsc --noEmit` fehlerfrei

**AufgerÃ¤umt:** `@modelcontextprotocol/sdk`, `@modelcontextprotocol/express`
(nie genutzt) aus den Dependencies entfernt.

**Bewusst zurÃ¼ckgestellt:** Resource-Exposure (`resources/list`/`read` fÃ¼r
Dateien zusÃ¤tzlich zu den Tools) â€” additiv, nicht sicherheitskritisch, siehe
`docs/HANDOFF.md`.

## 2026-09-11 â€” Produkt-Neuausrichtung: RheinAgent File Upload MCP

VollstÃ¤ndige Neuausrichtung von der UI-Test-Prototyp-Phase auf das offizielle
Produktbriefing (Protokoll `2026-07-28`, Package-v2-Profil
`rheinagent-file-upload@1`). Referenz-Repos (Manager/License/Update-Feed/
Audit/Knowledge/Backoffice) per Fork-Recherche auf aktuellem `main`-Stand
gelesen, exakte VertrÃ¤ge extrahiert (siehe `docs/HANDOFF.md` fÃ¼r die
gelesenen Commit-SHAs).

**Architektur:**
- Control Plane (`server.ts`, Port 3901) und Data Plane (`dataplane.ts`,
  Port 3902) als getrennte Prozesse â€” rohe Datei-Bytes laufen nie durch
  MCP-JSON
- Opake IDs (`src/lib/ids.ts`) fÃ¼r `file_id`/`job_id`/`upload_id`/
  `delete_token` â€” Path-Traversal strukturell ausgeschlossen, nicht nur
  sanitisiert
- Staging/Quarantine: Bytes landen erst in `data/staging/`, werden bei
  `upload_finalize` validiert und erst dann atomar nach `data/files/`
  verschoben
- Validierung: GrÃ¶ÃŸenlimit, Extension-Allowlist, Magic-Byte-Sniffing
  unabhÃ¤ngig von der deklarierten Extension, SHA-256-Hash
  (`src/lib/security.ts`)
- Archiv-Formate (`.zip` etc.) werden komplett abgelehnt statt entpackt â€”
  Archive-Bomb-Risiko dadurch strukturell ausgeschlossen
- Processor-Registry (`src/lib/processors.ts`) statt beliebigem Executor â€”
  aktuell `text_stats`, `text_uppercase`
- Read/Prepare/Apply/Verify durchgÃ¤ngig: Upload-, Process- und
  Delete-Flows haben je einen reversiblen Prepare- und einen tatsÃ¤chlich
  mutierenden Apply-Schritt
- Audit-Client (`src/lib/audit.ts`) nach `RA_AUDIT_MODE=off|hub`-Vertrag,
  content-free/allowlist-only, Write-Ahead mit Fail-Closed fÃ¼r kritische
  Schreiboperationen â€” implementiert, aber noch nicht gegen eine laufende
  Hub-Instanz verifiziert (siehe `docs/HANDOFF.md`)
- Alle 11 vorgesehenen Tools implementiert: `rheinagent_file_capabilities_get`,
  `_upload_prepare`, `_upload_finalize`, `_list`, `_get`, `_process_prepare`,
  `_process_apply`, `_job_get`, `_result_get`, `_delete_prepare`, `_delete_apply`

**Entfernt:** der bisherige UI-Test-Prototyp (`mcp-app.html`,
`src/mcp-app.ts`, `vite.config.ts`, `@modelcontextprotocol/ext-apps`) â€” neue
Tool-Namen sind nicht kompatibel dazu, UI ist laut Vorgabe optional und wird
als spÃ¤teres Fast-Follow behandelt (siehe `docs/HANDOFF.md`).

**Getestet:**
- Kompletter Upload-Flow (prepare â†’ PUT â†’ finalize) end-to-end per
  direktem JSON-RPC + HTTP
- Process-Flow (prepare â†’ apply â†’ job_get â†’ result_get) end-to-end
- Delete-Flow (prepare â†’ apply) end-to-end
- Security-Negativtest: als `.txt` deklariertes PNG wird bei `upload_finalize`
  korrekt abgelehnt (Magic-Byte-Mismatch)
- Security-Negativtest: ungÃ¼ltige `file_id` (`../../etc/passwd`) wird vor
  jedem Dateisystemzugriff abgewiesen
- 13 automatisierte Tests unter `test/security.test.ts` (`npm test`), alle grÃ¼n
- **Echter Bug gefunden und behoben:** `JsonIndex` cachte pro Prozess â€” da
  Control- und Data-Plane laut Architektur bewusst getrennte Prozesse sind,
  sah die Data Plane neu angelegte `upload_id`s aus der Control Plane nicht.
  Fix: jede Operation liest jetzt frisch von Platte statt aus einem
  In-Memory-Cache (siehe `src/lib/jsonIndex.ts`)

**Dokumentation neu angelegt:** `README.md`, `docs/ARCHITECTURE.md`,
`docs/SECURITY.md`, `docs/AUDIT.md`, `docs/LICENSE-FLOW.md`,
`docs/INSTALLATION.md`, `docs/VERSIONING.md`, `docs/HANDOFF.md`.

**Offen (vollstÃ¤ndige Liste in `docs/HANDOFF.md`):** Audit-Hub-Live-Test,
License/Manager/Update-Feed-Registrierung, Download-Endpunkt fÃ¼r groÃŸe/
binÃ¤re Dateien, Health/Doctor-Tool, Docker-Setup, UI-Wiederanbindung.

## 2026-09-11 â€” Persistenz auf Platte

- Dokumentenspeicher aus reinem In-Memory-`Map` in `store.ts` ausgelagert
- Schreibt bei jeder Ã„nderung (`upload`, `edit`, `delete`) nach `data/documents.json`
- LÃ¤dt beim Serverstart vorhandene Dokumente von Platte (`loadStore()`)
- `data/` ist in `.gitignore` â€” Nutzerdokumente landen nie im Repo
- Verifiziert: Upload â†’ Server-Neustart â†’ `list_documents` zeigt das Dokument weiterhin
- Bekannte Grenzen: kein Multi-User-/Session-Schutz (alle Clients teilen sich
  dieselbe Datei), keine GrÃ¶ÃŸenbegrenzung, keine VerschlÃ¼sselung

## 2026-09-11 â€” RheinAgent-Branding + LÃ¶schen/Mehrfach-Upload

- Farben/Schrift/Logo aus `brand_tokens.css`/`.json` (RheinAgent-Designpaket) ins Widget Ã¼bernommen
- Neues Tool `delete_document`
- Mehrfach-Datei-Upload im Widget (mehrere Dateien in einem Durchgang)
- "Zusammenfassen"-Button im Dokument-Viewer (manueller Re-Trigger ohne Re-Upload)
- Getestet: alle 5 Tools per direktem JSON-RPC (upload/list/view/edit/delete)

## 2026-09-11 â€” Erstversion: Dokument-Upload + LLM-Kontext-Push

- MCP-App-Server nach SEP-1865 (MCP Apps) mit `@modelcontextprotocol/ext-apps`
- Tools `upload_document`, `list_documents`, `get_document`, `edit_document`,
  alle an dieselbe `ui://documents/mcp-app.html`-Resource gekoppelt
- Widget: Upload-Drop-Zone, Dokumentliste, Viewer, Download (`app.downloadFile`)
- `app.updateModelContext()` + `app.sendMessage()` zum automatischen AnstoÃŸen
  einer Zusammenfassung im Chat nach Upload
- Live in Claude Desktop (remote) getestet via `cloudflared`-Tunnel und
  Tailscale Funnel â€” Rendering + InteraktivitÃ¤t bestÃ¤tigt
- Repo initial gepusht: `github.com/Codeelchi/rheinagent-file-upload`

## 2026-09-12 - Package-v2 Windows distribution integration

- Added exact Manager activation contract `rheinagent-file-upload@1` and bundled Windows x64 runtime builder under `packaging/distribution/`.
- Added Package-v2 build/verify tooling with Ed25519 detached signature, checksum/inventory/path safety checks and minimum Manager `0.4.0-rc.7`.
- Added the production public signing trust anchor only; SHA-256 `1c4f5d5ad3313381b7d96d8782c853d950a87ad2f6a285b2c060d325d77e4a15`. No production private key is stored here.
- Added GitHub and Forgejo distribution CI. CI signs only with an ephemeral key and rejects packages above 64 MiB or packages containing PEM/signing material.
- Runtime builder intentionally omits optional npm dependencies; the optional native Canvas dependency is not required by the PDF text extraction path and would consume unnecessary package budget.
- Local Windows runtime + MCP health + ephemeral Package-v2 verification passed; smoke package size 50,783,276 bytes.
- Added `.state/` and Python cache exclusions so local release/test state is never committed.