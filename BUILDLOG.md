# Buildlog

Chronologisches Protokoll der Änderungen an diesem MCP-Server. Neueste Einträge oben.

## 2026-09-11 — Versions-Bump `0.3.0`, README/HANDOFF auf aktuellen Stand

Abschluss der mehrteiligen Ausbaurunde zum File-Intake-/Analyse-Layer
(SQLite-Migration, 6 neue Extraction-Processoren, Chunking,
Duplikat-Erkennung, Knowledge-Handoff-Contract, Docker/Compose,
Health/Capabilities-Erweiterung — siehe die jeweiligen Einträge unten).

- **`package.json`/`package-lock.json` `0.2.0` → `0.3.0`** (MINOR: echte
  Feature-Erweiterung + additive, aber bei strikter Validierung sichtbare
  Schema-Erweiterung, siehe `docs/VERSIONING.md` für die volle Begründung).
  `PRODUCT_VERSION` (liest jetzt `package.json` zur Laufzeit) macht das
  automatisch überall sichtbar, wo es referenziert wird — kein manuelles
  Nachziehen mehr nötig außer in `docs/VERSIONING.md` selbst.
- **`README.md` komplett neu geschrieben** — der vorherige Stand nannte
  nur 5 Processor und 15 Tools und war seit mehreren Runden nicht mehr
  aktuell. Jetzt: alle 18 Tools, alle 11 Processor, Docker-Schnellstart,
  vollständige Dokuverlinkung (`PROCESSORS.md`/`KNOWLEDGE-INTEGRATION.md`/
  `STATE-MIGRATION.md` waren dort noch gar nicht verlinkt).
- **`docs/HANDOFF.md`s "Einstieg für eine neue Session" überarbeitet** —
  verwies noch auf einen längst nicht mehr relevanten lokalen Pfad
  (`/home/Technowolf/mcp-ui-test` auf `berry`, aus einer Zeit vor diesem
  GitHub-Workflow) und einen veralteten Funktionsstand (16 Tools/86 Tests).
  Jetzt akkurat, inkl. ehrlicher Liste dessen, was in dieser Ausbaurunde
  bewusst **nicht** umgesetzt wurde (kein echter `docker build` gegen einen
  Daemon, keine Cursor-Paginierung für `csv_inspect`/`xlsx_inspect`, kein
  generischer Entpack-Processor, kein Schema-Migrationsframework, keine
  UI, keine Cross-Repo-Schritte).

`npm run check` weiterhin fehlerfrei (155 Tests, keine neuen — reine
Doku-/Versions-Pflege).

## 2026-09-11 — Health/Capabilities erweitert, Symlink-Sicherheitstests

Auftrag: Ausbau zum File-Intake-/Analyse-Layer, restliche kleinere Punkte
aus Phase 9/Definition-of-Done ("Health/Doctor erweitert", "Capabilities
aktuell", Security-Testabdeckung).

**`product_version`/`state_schema_version`** neu sowohl in
`rheinagent_file_capabilities_get` als auch `rheinagent_file_health_get`.
`PRODUCT_VERSION` liest `package.json#version` zur Laufzeit
(`src/lib/capabilities.ts`) statt eine dritte hartkodierte Kopie zu sein —
vorher stand `"0.2.0"` sowohl in `package.json` als auch separat in
`server.ts`s `McpServer`-Identität; jetzt eine einzige Quelle.
`STATE_SCHEMA_VERSION` (aktuell `1`) macht das in `docs/VERSIONING.md`
("Schema-Kompatibilität") schon beschriebene, bisher nirgends im Tool-
Output sichtbare Konzept erstmals abfragbar.

**`processor_registry.processor_count`, `jobs` (`prepared`/`completed`/
`failed`)** neu in `rheinagent_file_health_get` — `getJobStats()`
(`store.ts`, neu) zählt Jobs nach Zustand, ohne durch
`rheinagent_file_job_list` paginieren zu müssen. Ein Betreiber sieht so
direkt "stauen sich fehlgeschlagene Jobs an", ohne das selbst
zusammenzurechnen.

**3 neue Symlink-Sicherheitstests** (`test/security.test.ts`) für
`assertNotSymlink()` — bisher ganz ohne dedizierte Tests, obwohl es die
letzte Verteidigungslinie vor jedem Schreib-/Rename-Ziel in `store.ts`
ist (`finalizeFile`/`writeJobResult`). Echter Symlink angelegt, Ablehnung
verifiziert.

Live end-to-end über echten HTTP-Flow verifiziert:
`rheinagent_file_health_get` liefert korrekt `product_version: "0.2.0"`,
`state_schema_version: 1`, `processor_registry.processor_count: 11`,
`jobs: {prepared:0,completed:0,failed:0}`.

4 neue automatisierte Tests, 1 bestehender Test-Fixture-Body aktualisiert
— jetzt **155 automatisierte Tests**, `npm run check` fehlerfrei.

## 2026-09-11 — Docker/Produktionsrunntime

Auftrag: Ausbau zum File-Intake-/Analyse-Layer, Phase 8 (Production
Runtime) der priorisierten Reihenfolge.

**Build-Skripte** (`package.json`): `npm run build` (`tsc` → `dist/`),
`npm run start`/`start:dataplane` (`node dist/server.js`/`dist/dataplane.js`
— reines `node`, kein `tsx`/`typescript` zur Laufzeit). Live verifiziert:
kompilierter Build läuft standalone, `/mcp` antwortet korrekt.

**`Dockerfile`** (Multi-Stage) — Build-Stage mit `npm ci` (inkl.
Dev-Dependencies für `tsc`), Runtime-Stage ausschließlich mit `npm ci
--omit=dev` (kein `tsx`/`typescript` im Runtime-Layer, wie gefordert),
`node:22-alpine`, non-root `rheinagent`-User.

**`docker-compose.yml`** — zwei Services (`file-control`/`file-data`) aus
demselben Image, gemeinsames benanntes Volume für `/app/data`. Bewusst
**kein** Supervisor-Prozess in einem gemeinsamen Container (Docker/Compose
ist bereits Prozessmanager, ein Supervisor wäre unnötige zusätzliche
Angriffsfläche) — mirrort stattdessen 1:1 die bestehende
Zwei-Prozess-Architektur. `network_mode: host` (Linux) statt Bridge +
Port-Publishing: **echter Bug gefunden und behoben**, bevor er in Produktion
hätte auffallen können — `upload_url`/`download_url` sowie der interne
Health-Reachability-Check in `server.ts` waren fest auf `http://localhost:…`
verdrahtet; unter Bridge-Networking hätte das bedeutet, dass weder die
Control Plane die Data Plane erreicht noch ein externer MCP-Client die
zurückgegebene `upload_url` je auflösen könnte. Fix: neue
`RHEINAGENT_FILE_UPLOAD_DATAPLANE_HOST`-Env-Var (Default weiterhin
`localhost`, keine Verhaltensänderung im bisherigen Einzelprozess-Betrieb)
plus `network_mode: host` im Compose-Setup, damit `localhost` in beiden
Containern weiterhin dasselbe bedeutet wie im nicht-containerisierten
Betrieb — keine zweite Hostname-Konfiguration für intern vs. extern
beworbene URLs nötig. Sicherheitsmaßnahmen: `read_only: true`,
`cap_drop: [ALL]`, `no-new-privileges`, Docker-`HEALTHCHECK`.

**Neues Control-Plane-`/healthz`** (`server.ts`, reine HTTP-Liveness,
kein MCP) — analog zum bereits vorhandenen Data-Plane-`/healthz`, damit
beide Planes einen einheitlichen, geschäftslogikfreien Liveness-Endpunkt
für einen Container-Healthcheck haben (bewusst **nicht** dasselbe wie das
MCP-Tool `rheinagent_file_health_get`, das echte Abhängigkeitschecks macht).
Live verifiziert.

**CI-Docker-Build-Smoke** (`.github/workflows/ci.yml`, neuer Job
`docker-build-smoke`) — baut das Image bei jedem Push/PR, damit ein
kaputtes Dockerfile nicht erst bei einem echten Deploy auffällt.

**Verifikationsstand, ehrlich benannt**: `docker build`/`docker compose up`
liefen **nicht** gegen einen echten Docker-Daemon (dieser Session stand
nur der `docker`-CLI-Client ohne laufenden Daemon zur Verfügung) —
`docker compose config` validiert die Compose-Datei syntaktisch
fehlerfrei, mehr war lokal nicht möglich. Der eigentliche Programmcode
(kompilierter Build via `node dist/server.js`) wurde außerhalb von Docker
live verifiziert. Der neue CI-Job deckt den echten `docker build` ab die
nächsten Male, wenn dieser Branch pusht/einen PR öffnet — bis dahin gilt
Docker/Compose als **implementiert, nicht per echtem Docker-Build
verifiziert**. `docs/INSTALLATION.md` benennt das explizit.

`npm run check` weiterhin fehlerfrei (152 Tests, keine neuen — reine
Infrastruktur-/Build-Änderung, kein neuer Programmcode mit eigenem
Testbedarf außer dem bereits bestehenden `server.ts`-Testabdeckungsstand).

## 2026-09-11 — Knowledge-Handoff-Contract (`rheinagent_file_knowledge_handoff_prepare`, 18. Tool)

Auftrag: Ausbau zum File-Intake-/Analyse-Layer, Phase 6 (Knowledge-
Integration) der priorisierten Reihenfolge. Vorgabe: lose Kopplung, **kein**
Bypass von Knowledges eigenem Contribution-/Review-/Publish-Flow, keine
erfundenen `scope`/`classification`/`owner`-Werte.

**Erst recherchiert, dann gebaut.** Ein Subagent hat den tatsächlichen
`main`-Stand von `Codeelchi/rheinagent-knowledge-mcp` gelesen (nicht nur
dessen Dokumentation): `knowledge_contribution_create` akzeptiert
**ausschließlich** `{topic, department, scope, answers[], statements[]}`
— **kein** `title`/`content`/`tags`/`classification`-Feld existiert dort
bei Contribution-Erstellung überhaupt (die Zielvorgabe für diese Session
ging von einem anderen, generischeren Schema aus — der reale Contract war
enger). `scope` muss zudem einer dem aufrufenden Principal bereits
gewährten Data-Scope entsprechen (`contributionScopeAllowed()` prüft
`principal.dataScopes`), ist also strukturell nie frei erfindbar.

**`rheinagent_file_knowledge_handoff_prepare`** (neu, rein lesend) —
`src/lib/knowledgeHandoff.ts` baut aus einem `file_id` + optionalem
`extraction_job_id` (bereits abgeschlossener Extraction-Job derselben
Datei) einen Vorschlag in exakt der oben verifizierten Knowledge-Form:
- `topic`: Dateiname (Vorschlag, keine Erfindung).
- `department`/`scope`: **immer `null`** + Eintrag in `requires_user_input`
  — dieses Produkt hat keine Knowledge-Tenant-Identität und kann diese
  Werte strukturell nicht kennen, geschweige denn raten.
- `answers`: immer `[]`.
- `statements`: aus dem `text`-Feld des Job-Ergebnisses, auf
  Absatzgrenzen gesplittet, hart auf Knowledges eigene Grenzen begrenzt
  (max. 100 Statements, je max. 5000 Zeichen) — der Aufrufer kann das
  Ergebnis ohne eigenes Nach-Chunking direkt an
  `knowledge_contribution_create` weiterreichen.
- `ready: true` bedeutet **nur** "trägt echten Content", nie "sicher
  automatisch einreichbar" — es gibt keinen automatischen Übergang zu
  Knowledges eigenen Tools.

Ruft Knowledge **nie selbst auf** — reine Vorschlagserstellung, die
Einreichung bleibt bewusst beim aufrufenden Client/Agenten mit dessen
eigener Knowledge-Identität.

Live end-to-end über echten HTTP-Flow verifiziert: Upload einer
Zwei-Absatz-Textdatei → ohne `extraction_job_id`: `ready: false`,
`statements: []`, erklärende `warnings` → mit vorher per `text_extract`
abgeschlossenem Job: `ready: true`, zwei `statements` exakt entsprechend
den beiden Absätzen, `department`/`scope` weiterhin `null`.

10 neue automatisierte Tests (`test/knowledgeHandoff.test.ts`: Chunking-
Grenzfälle, nie erfundenes `department`/`scope`, Job-nicht-abgeschlossen-
Warnung, fehlendes `text`-Feld) — jetzt **18 Tools**, **152 automatisierte
Tests**, `npm run check` fehlerfrei. Neue Referenz-Doku
[KNOWLEDGE-INTEGRATION.md](docs/KNOWLEDGE-INTEGRATION.md) (vollständige
Contract-Dokumentation inkl. der Recherche-Erkenntnisse).

## 2026-09-11 — `rheinagent_file_duplicate_check` (17. Tool)

Auftrag: Ausbau zum File-Intake-/Analyse-Layer, Phase 5 (Deduplikation)
der priorisierten Reihenfolge.

Neues, rein lesendes Tool `rheinagent_file_duplicate_check` — nutzt den
bei `upload_finalize` bereits erfassten SHA-256 (`findFilesBySha256()` in
`store.ts`, neu). Nimmt **genau eins** von `file_id` (findet jede andere
akzeptierte Datei mit identischem Inhalt, schließt die Datei selbst aus)
oder `sha256` direkt entgegen (Duplicate-Check schon *vor* einem Upload).
Löscht/merged nie automatisch — reines Lookup, die Entscheidung bleibt
beim Aufrufer. Input-Validierung (`Sha256Field`, `DuplicateCheckInputSchema`
mit `.refine()` für "genau eins von beiden") als benannte, testbare
Schemas in `src/lib/schemas.ts`, demselben Muster wie die bestehenden
`*IdField`-Validatoren.

Live end-to-end über echten HTTP-Flow verifiziert (beide Prozesse
tatsächlich gestartet): zwei Dateien mit identischem Inhalt hochgeladen,
`duplicate_check` per `file_id` findet die jeweils andere (nicht sich
selbst), per `sha256` direkt findet beide, eine dritte Datei mit
eindeutigem Inhalt liefert `duplicates: []`, beide/keins der Felder
scheitert klar als `Input validation error`.

8 neue automatisierte Tests (3 `store.test.ts`, 2 `contracts.test.ts` für
die Schemas) — jetzt **17 Tools**, **142 automatisierte Tests**, `npm run
check` fehlerfrei. `docs/ARCHITECTURE.md` (Tool-Tabelle),
`src/lib/capabilities.ts` (`usage`-Schritte) aktualisiert.

## 2026-09-11 — Chunking für `text_extract`/`docx_extract_text`

Auftrag: Ausbau zum File-Intake-/Analyse-Layer, Phase 4 (Chunking) der
priorisierten Reihenfolge — "auch ein 100-Seiten-Dokument muss vollständig
analysierbar sein, ohne einen riesigen MCP-Response zu erzeugen".

`text_extract` und `docx_extract_text` (die beiden Processor für
unpaginierten Fließtext beliebiger Länge) nehmen jetzt `options.offset`/
`options.limit` entgegen und liefern zusätzlich `total_chars`/
`next_offset`. Ein Client liest ein beliebig langes Dokument vollständig,
indem er wiederholt mit `offset = vorheriger next_offset` aufruft, bis
`next_offset: null`. Bewusst **kein** neues, formatübergreifendes
Chunk-Entity/-Tool — `pdf_extract_text`s bereits vorhandenes
`options.page` und `xlsx_inspect`s zeilenbasierte Stichprobe lösen
dasselbe Problem bereits mit dem für ihr Format passenderen Chunk-Begriff
(Seite bzw. Zeile statt Zeichenfenster); eine künstliche gemeinsame
Chunk-Abstraktion über alle Formate hätte für keines davon wirklich
gepasst. `docx_extract_text` scannt intern jetzt bis zu 10 MiB Text (statt
vorher hart bei 64 KiB abzuschneiden), damit auch lange Dokumente
vollständig chunk-weise erreichbar sind.

Live end-to-end verifiziert: ein ~145 000 Zeichen langer Text wurde per
wiederholtem `text_extract`-Aufruf (3 Chunks à max. 64 KiB) exakt
byte-identisch wieder zusammengesetzt.

5 neue automatisierte Tests (Chunk-Walk über ein komplettes Dokument,
Offset-/Limit-Validierung, docx-Chunking) — jetzt **137 automatisierte
Tests**, `npm run check` fehlerfrei. `docs/PROCESSORS.md` um den
Chunking-Abschnitt ergänzt (inkl. offen gelassenem nächsten Schritt für
`csv_inspect`/`xlsx_inspect`, aktuell kein bekanntes reales Bedürfnis dafür).

## 2026-09-11 — Document-Extraction-Processoren: CSV/JSON/Markdown/DOCX/XLSX

Auftrag: Ausbau zum File-Intake-/Analyse-Layer, Phase 3 (Document
Extraction) der priorisierten Reihenfolge.

**6 neue Processor, 2 neue `mime_category`-Erweiterungen.** Ziel:
`txt`/`md`/`csv`/`json`/`pdf`/`docx`/`xlsx` sinnvoll analysierbar, mit
harten Ressourcen-Limits, ohne neue Laufzeit-Abhängigkeit.

- **`text_extract`** (text) — bounded Volltext (64 KiB) + char/word/line-Counts,
  Pendant zu `pdf_extract_text` für reine Textdateien (vorher gab es nur
  `text_stats`, das keinen Inhalt zurückgab).
- **`markdown_structure`** (text, nur `.md`) — Headings, Link-Count,
  Code-Block-Count. Keine Markdown-Ausführung.
- **`csv_inspect`** (text, nur `.csv`) — hand-geschriebener RFC-4180-naher
  Tokenizer (Quoting, escaped `""`, eingebettete Delimiter/Newlines in
  Quotes), Delimiter-Auto-Erkennung (`,`/`;`/Tab) oder `options.delimiter`.
  Limits: max. 5000 gescannte Zeilen, max. 20 Beispielzeilen, 500 Zeichen
  pro Zelle.
- **`json_inspect`** (text, nur `.json`) — `root_type`/`keys`/`array_length`/
  bounded `sample`. **Sicherheitsdetail**: ein Bracket-Tiefen-Scan über den
  rohen Text läuft *vor* `JSON.parse()` und lehnt > 64 Verschachtelungs-
  ebenen ab — verhindert, dass `JSON.parse`s eigener rekursiver Abstieg je
  mit absurd tiefem Input konfrontiert wird (Stack-Overflow-Risiko).
- **`docx_extract_text`** / **`xlsx_inspect`** (neue `mime_category: "office"`,
  nur `.docx`/`.xlsx`) — beide sind ZIP-Container (OOXML). Zwei neue Module
  dafür, bewusst *keine* allgemeinen Unzip-/XML-Parser:
  - `src/lib/officeZip.ts`: hand-geschriebener ZIP-Central-Directory-Reader.
    Entpackt **nur** explizit angeforderte Einträge (nie alle), schreibt nie
    auf die Platte (Entry-Namen sind reine In-Memory-Map-Keys — Zip-Slip
    strukturell nicht anwendbar), begrenzt via Node's eigenem
    `zlib.inflateRawSync(..., {maxOutputLength})` pro Entry (20 MiB) und
    kumulativ (40 MiB), maximal 5000 Central-Directory-Einträge.
  - `src/lib/officeXml.ts`: enges Tag-/Regex-Scanning für die bekannten
    OOXML-Tags (`<w:t>`, `<sheet>`, `<si>`, `<row>`/`<c>`) statt eines
    echten XML-Parsers — kein XXE-Risiko, da nie ein `<!DOCTYPE>` oder eine
    externe Entity interpretiert wird (nur die 5 vordefinierten Entities +
    numerische Zeichenreferenzen).
  - **`sniffMimeCategory()` unterscheidet jetzt "echtes" OOXML von einem
    einfachen `.zip`**: ein auf `.docx` umbenanntes `.zip` besteht die
    Extension-Prüfung, scheitert aber an der Sniff/Declared-Konsistenzprüfung
    (`isOoxmlOfficeContainer()` prüft `[Content_Types].xml` auf eine echte
    `wordprocessingml.document.main`/`spreadsheetml.sheet.main`-Deklaration).
  - `xlsx_inspect`: Shared-Strings bounded auf 20 000 Einträge
    (`shared_strings_truncated`-Flag statt unbegrenztem Array — explizite
    Verteidigung gegen eine "sharedStrings-Bombe"), Zeilen-/Spalten-Count
    primär aus `<dimension>` (exakt, ohne Vollscan), sonst begrenzter
    Row-Scan (5000) mit `truncated`-Flag, `options.sheet` wählt ein
    bestimmtes Arbeitsblatt.
- **Kein neues `npm`-Package.** Alles mit Node-Bordmitteln (`zlib`,
  Regex/String-Scanning) — dieselbe Supply-Chain-Logik wie die
  `pdfjs-dist`-Entscheidung.

**Live-Sicherheitsverifikation** (nicht nur Unit-Tests, echte Angriffs-
payloads durchgespielt): Zip-Bomb (25 MiB hochkomprimierbare Nutzlast,
komprimiert auf wenige KB) sauber als Job-Fehler abgelehnt, *bevor* der
große Buffer je materialisiert wird; Entry-Count-Bomb (6000 leere Einträge)
vor jedem Inflate-Versuch abgelehnt; sharedStrings-Bomb (50 000 deklarierte
Einträge) korrekt auf 20 000 gekappt statt Speicher zu erschöpfen; extrem
tiefes JSON (100 000 Ebenen) vor `JSON.parse()` abgelehnt; korruptes/nicht-
ZIP `.docx` sauber als Job-Fehler abgelehnt; ein plain `.zip`, umbenannt zu
`.docx`, wird beim Sniff korrekt als `archive` (nicht `office`) erkannt und
scheitert an der Upload-Konsistenzprüfung.

**Vollständiger Echt-HTTP-End-to-End-Test** (beide Prozesse tatsächlich
gestartet, echte `curl`-Requests, kein reiner Unit-Test): ein via Python
gebautes `.docx` über `upload_prepare` → Data-Plane-`PUT` → `upload_finalize`
(korrekt als `mime_category: "office"` klassifiziert) → `process_prepare`
(`docx_extract_text`) → `process_apply` → `result_get` — Ergebnis enthält
exakt den erwarteten extrahierten Text.

**Neue Test-Infrastruktur**: `test/testZip.ts` (kein `*.test.ts` — wird
nicht als eigene Testdatei ausgeführt) — ein minimaler, spec-valider
ZIP-Writer in reinem TypeScript (lokale + zentrale Header + EOCD, `store`/
`deflate`), damit Zip-/Office-Tests ohne externe Binär-Fixtures oder
Python-Abhängigkeit auskommen, im Stil der bereits vorhandenen
Hand-Builder für PNG/JPEG in `test/processors.test.ts`.

**48 neue automatisierte Tests** (`test/officeZip.test.ts` 9,
`test/officeXml.test.ts` 10, `test/processors.test.ts` +25, `test/security.test.ts`
+4) — jetzt **11 Processor** (vorher 5), **16 Tools** (unverändert, reine
Processor-Erweiterung, kein neues Tool), **134 automatisierte Tests**,
`npm run check` fehlerfrei. Neue Referenz-Doku
[PROCESSORS.md](docs/PROCESSORS.md) (vollständige Options-/Limit-Tabelle für
alle Processor). `docs/ARCHITECTURE.md`/`docs/SECURITY.md` aktualisiert.

## 2026-09-11 — Persistence-Migration JSON → SQLite

Auftrag: Ausbau zum File-Intake-/Analyse-Layer (mehrteiliger Auftrag,
mehrere Runden). Erste Runde: Baseline-Hygiene (siehe vorheriger Eintrag,
CI) + Persistence-Härtung, wie in der Zielvorgabe als Phase 2 priorisiert.

**Metadaten-Persistenz auf SQLite migriert.** `src/lib/jsonIndex.ts`
(whole-file-JSON, "last write wins" bei echter Gleichzeitigkeit zwischen
Control-/Data-Plane-Prozess, dokumentierte bekannte Grenze in
`SECURITY.md`) ersetzt durch `src/lib/sqliteIndex.ts` — `node:sqlite`
(eingebaut seit Node 22, keine neue Dependency, kein natives Addon, gleiche
Supply-Chain-Logik wie die `pdfjs-dist`-Entscheidung), WAL-Modus, echte
Read-Committed-Transaktionen pro Zeile statt Whole-File-Rewrite. Identischer
öffentlicher Vertrag (`get`/`values`/`set`/`delete`) — `store.ts` musste nur
die Instanziierung der fünf Tabellen ändern (`uploads`/`files`/`jobs`/
`deletes`/`downloads`), kein anderer Aufrufer betroffen. Details/Begründung:
`docs/STATE-MIGRATION.md` (neu).

Automatische, idempotente Migration bestehender `data/meta/*.json`-Dateien
beim Start (`migrateLegacyJsonMetadata()` in `ensureDirs()`) — importiert
nur in eine noch leere Zieltabelle, benennt die JSON-Quelle danach zu
`.migrated` um statt sie zu löschen. Live end-to-end verifiziert: eine
handgeschriebene Alt-JSON-Datei wurde korrekt importiert, per direkter
SQLite-Abfrage bestätigt, Quelldatei lag danach als `.migrated` vor.

`test/jsonIndex.test.ts` (9 Tests) entfernt (Modul ist tot, keine
verbleibenden Aufrufer), `test/sqliteIndex.test.ts` (neu, 10 Tests) deckt
denselben Verhaltensvertrag plus SQLite-spezifische Fälle (mehrere
Tabellen pro Datei unabhängig, Migration, kein Überschreiben vorhandener
Zeilen) ab. Netto **87 automatisierte Tests**, `npm run check` fehlerfrei.
`docs/VERSIONING.md`/`docs/SECURITY.md`/`docs/ARCHITECTURE.md` auf den
neuen Stand gebracht; dabei auch den seit Längerem bestehenden
Versions-Drift behoben (`VERSIONING.md` nannte noch `0.1.0`,
`package.json` stand längst auf `0.2.0`).

## 2026-09-11 — GitHub-Actions-CI-Workflow

Auftrag: letzte Session prüfen und weiterarbeiten. Repo war sauber (working
tree clean, lokal = `origin/claude/mcp-server-continuation-fb3oq2`), 86
Tests grün, `tsc --noEmit` fehlerfrei — kein unfertiger Stand vorgefunden.
Nächster offener Punkt aus `HANDOFF.md` umgesetzt: der zuvor manuelle
`npm run check` läuft jetzt automatisiert bei jedem Push/PR gegen `main`.

`.github/workflows/ci.yml` (neu) — `actions/checkout` + `actions/setup-node`
(Node 22, npm-Cache), dann `npm ci` und `npm run check` (Typecheck + alle
86 Tests). Keine funktionalen Code-Änderungen an diesem Produkt selbst,
reine Absicherung des Release-Gates aus `VERSIONING.md`.

## 2026-09-11 — rheinagent_file_verify, Processor-Optionen, jsonIndex-Tests

Auftrag: weitere Verbesserungen/Features für den MCP überlegen und
umsetzen. Vor der Feature-Arbeit erst eine echte Qualitätslücke
geschlossen, dann zwei neue Features.

**0. `test/jsonIndex.test.ts` (neu).** `src/lib/jsonIndex.ts` — der
Persistenz-Layer unter jeder einzelnen `store.ts`-Operation — war das
letzte `src/lib`-Modul ganz ohne dedizierte Tests. 9 neue Tests: Basis-
Get/Set/Delete/Values, `mkdir(recursive)` beim ersten Write, Overwrite
lässt andere Einträge unberührt, `delete()` auf nie existierende ID
persistiert keine leere Datei, zwei unabhängige `JsonIndex`-Instanzen auf
derselben Datei sehen sich gegenseitige Writes (simuliert die echte
Control-/Data-Plane-Prozesstrennung ohne zwei OS-Prozesse), Atomic-Rename
hinterlässt keine `.tmp-*`-Leichen, kaputtes JSON auf der Platte wirft statt
still als leerer Index behandelt zu werden.

**1. `rheinagent_file_verify`** (neu, 16. Tool) — `verifyFile()` in
`store.ts` liest die Bytes einer Datei neu, berechnet SHA-256 neu,
vergleicht gegen den bei `upload_finalize` erfassten Wert.
`upload_finalize` prüft Integrität nur einmalig beim Empfang; dieses Tool
ist die einzige Stelle, die das danach erneut tut (Disk-Korruption, Bit Rot
auf einer langlebigen Pi-SD-Karte, ein manueller Eingriff in
`data/files/`). Rein lesend, keine Zustandsänderung. Bewusst **kein**
`isError` bei einem Mismatch — dieselbe Konvention wie `health_get`s
`status: "degraded"`: der Tool-Aufruf selbst war erfolgreich, `matches:
false` ist ein echter Befund, kein Fehler des Aufrufs.

**2. Processor-Optionen.** `rheinagent_file_process_prepare` nimmt jetzt
ein optionales `options`-Objekt (`z.record(z.string(), z.unknown())`),
gespeichert am `JobRecord` (`options?: Record<string, unknown>`, neues
optionales Feld, nur gesetzt wenn übergeben) und bei `process_apply`
unverändert an `ProcessorContext.options` durchgereicht.
`pdf_extract_text` ist der erste Nutzer: `{"page": N}` (1-indexiert)
extrahiert eine einzelne Seite statt des gesamten Dokuments — der
naheliegende Workaround für PDFs, deren Volltext über der
64-KiB-Ergebnisgrenze liegt. `parsePageOption()` validiert Typ/Bereich
und wirft für alles Ungültige einen klaren Fehler, statt still auf "ganzes
Dokument" oder "Seite 1" zurückzufallen; ein außerhalb des Seitenbereichs
liegender Wert scheitert ebenso klar nach dem Laden des Dokuments (dann ist
`doc.numPages` bekannt). Ergebnis trägt jetzt zusätzlich `page` (`null` =
ganzes Dokument).

**Getestet:** Live end-to-end gegen beide laufenden Prozesse — 2-seitige
Test-PDF hochgeladen, `process_prepare` mit `options: {"page": 2}` →
`process_apply` liefert exakt `"Page Two Text"` (nicht Seite 1), `options`
rundet korrekt in `job_get`s Antwort, `options: {"page": 99}` scheitert
sauber als Job-`state: "failed"` mit `"out of range"`-Meldung.
`rheinagent_file_verify` gegen unveränderte Datei → `matches: true`; nach
direktem Byte-Anhängen an die Datei auf der Platte (`data/files/<file_id>`)
→ `matches: false`, unterschiedliche `actual_sha256`, kein `isError`. 17
neue automatisierte Tests (9× `jsonIndex`, 3× `verifyFile`, 4×
`pdf_extract_text`-Optionen, 1× `createJob`-Options-Passthrough) — jetzt
**16 Tools, 86 automatisierte Tests, alle grün**; `npm run check`
fehlerfrei.

**Doku aktualisiert:** `docs/ARCHITECTURE.md` (Processor-Optionen-Absatz,
`pdf_extract_text`-Tabellenzeile, `verify`-Absatz, Tool-Vertragstabelle,
Diagramm 15→16 Tools), `README.md`, `docs/VERSIONING.md`,
`docs/HANDOFF.md`.

## 2026-09-11 — Filter für file_list/job_list, Mime-Category-Storage-Breakdown

Auftrag: Funktionen des MCP weiter verbessern (Fortsetzung der letzten
Runde). Drei Erweiterungen:

**1. `rheinagent_file_list` filterbar.** Neue optionale Input-Felder
`mime_category` (exakt) und `filename_contains` (case-insensitive
Substring). `listFilesPage()` (`store.ts`) nimmt jetzt einen `FileListFilter`
als ersten Parameter; Filterung läuft vor der Pagination, sodass
`cursor`/`next_cursor` über die gefilterte Menge laufen. Live verifiziert:
`filename_contains=invoice` findet `Invoice-2026-09.txt` case-insensitiv,
lässt `receipt.txt` aus; `mime_category=text` liefert beide Textdateien.

**2. `rheinagent_file_job_list` filterbar.** Neue optionale Input-Felder
`state` (`prepared`/`completed`/`failed`) und `processor_id`, zusätzlich
zum bestehenden `file_id`. `listJobsPage()` nimmt jetzt einen
`JobListFilter` (`fileId?`, `state?`, `processorId?`) statt nur `fileId?`
— Breaking Change der internen Signatur, alle Call-Sites (`server.ts`,
`test/store.test.ts`) angepasst. Live verifiziert: `state=completed`
findet nur den fertigen Job, `processor_id=text_uppercase` nur den
laufenden.

**3. `rheinagent_file_health_get`s `storage.by_mime_category`.**
`getStorageStats()` schlüsselt Anzahl+Bytes jetzt zusätzlich pro
`mime_category` auf. **Live-Bug gefangen und gefixt:** Erste Version nutzte
`z.record(MimeCategorySchema, ...)` im `HealthSchema` — zod v4 verlangt bei
einem Record mit Enum-Key-Schema laut Spec **alle** Enum-Werte als
vorhandene Keys, nicht nur die tatsächlich befüllten. Jede reale Instanz
(die z. B. nie eine `.zip` hochgeladen bekam) scheiterte dadurch mit
`Output validation error: ... storage.by_mime_category.archive: expected
object, received undefined` — live beim End-to-End-Test aufgefallen, sofort
auf `z.partialRecord(...)` korrigiert und erneut verifiziert. Neuer
Regressionstest in `test/contracts.test.ts` prüft genau dieses Szenario
(nur `text` befüllt, `HealthSchema.safeParse` muss erfolgreich sein).

**Getestet:** Live end-to-end gegen beide laufenden Prozesse (Filter-
Kombinationen für beide List-Tools, `health_get` vor und nach dem
Schema-Fix). 5 neue automatisierte Tests (`test/store.test.ts`: 2×
`listFilesPage`-Filter, 1× `listJobsPage`-Filter, 1×
`getStorageStats`-Breakdown; `test/contracts.test.ts`: 1× Regressionstest)
— jetzt **69 automatisierte Tests, alle grün**; `npm run check` fehlerfrei.

**Doku aktualisiert:** `docs/ARCHITECTURE.md` (Tool-Vertragstabelle,
List-Filter-Absatz, Health/Doctor-Absatz um `by_mime_category` ergänzt),
`README.md`, `docs/HANDOFF.md`.

## 2026-09-11 — PDF/Image-Processoren, Job-Listing, Storage-Stats, Rename

Auftrag: weitere Verbesserungen für die *Funktionen* des MCP (nicht
Infrastruktur/Security wie die letzten Runden). Fünf vorgeschlagene Punkte
vollständig umgesetzt.

**1. PDF/Image-Processoren.** `pdf`/`image` waren erlaubte
`mime_category`-Werte ohne jeden Processor — größte funktionale Lücke.

- `image_metadata` (`src/lib/processors.ts`): PNG-/JPEG-Dimensionen per
  Hand geparst (`parsePngDimensions()`: feste Offsets im IHDR-Chunk;
  `parseJpegDimensions()`: Marker-Scan bis zum SOF0–SOF15-Segment,
  DHT/JPG/DAC ausgenommen) — bewusst keine Bildbibliothek. Getestet gegen
  echte, in Node synthetisch erzeugte PNG/JPEG-Bytes: 64×32 PNG und
  100×50 JPEG korrekt erkannt.
- `pdf_metadata`/`pdf_extract_text`: neue Abhängigkeit `pdfjs-dist`
  (Mozillas PDF.js-Kern, null eigene Laufzeit-Abhängigkeiten) — bewusst
  **nicht** `pdf-parse`, das `@napi-rs/canvas` (natives Rust-Addon,
  unnötig für Textextraktion, auf arm64 unerwünscht) als Hard-Dependency
  zieht. Läuft ohne Worker (`workerSrc` nicht gesetzt — pdf.js erkennt
  Node und parst synchron im Hauptthread). Getestet gegen ein
  handgeschriebenes minimales PDF: Textextraktion und Metadaten
  (`page_count`, `pdf_format_version`) korrekt.
- Extrahierter Text ist auf 64 KiB gekappt (`PDF_TEXT_MAX_CHARS`, analog zu
  `INLINE_CONTENT_MAX_BYTES`) — das Ergebnis fließt über `result_get` durch
  MCP-JSON zurück, kein Freibrief für beliebig große Payloads.

**2. Prepare-Zeit-Validierung `processor_id` vs. `mime_category`.**
Processor-Registry-Refactor: jeder Eintrag deklariert jetzt
`supportedMimeCategories` (`ProcessorEntry`, `processorSupportsMimeCategory()`).
`rheinagent_file_process_prepare` lehnt eine falsche Kombination (z. B.
`text_stats` gegen eine PDF) jetzt sofort ab, statt einen Job anzulegen,
der erst bei `process_apply` mit `state: "failed"` endet. Live verifiziert:
`text_stats` gegen eine hochgeladene PDF → klare Fehlermeldung direkt bei
`process_prepare`, kein Job angelegt.

**3. `rheinagent_file_job_list`** (neu) — Pendant zu `rheinagent_file_list`
für Jobs (`listJobsPage()` in `store.ts`), optional nach `file_id`
gefiltert, cursor-paginiert nach demselben Muster. Live verifiziert:
gefiltert nach `file_id` liefert genau die zwei zu dieser Datei gehörigen
Jobs.

**4. Storage-Stats in `rheinagent_file_health_get`.** Neues
`storage`-Feld (`file_count`, `total_bytes`, `staging_file_count`) aus
`getStorageStats()` — zählt auch `pendingDelete`-Dateien mit (Bytes bis
`delete_apply` noch belegt). Live verifiziert nach 3 Uploads:
`file_count: 3, total_bytes: 586`.

**5. `rheinagent_file_rename`** (neu) — ändert nur `filename`; `file_id`,
Bytes, `sha256`, `mime_category` bleiben unverändert. `renameFile()` in
`store.ts` lehnt einen Rename ab, der die effektive `mime_category` ändern
würde (z. B. `.txt` → `.pdf`) — sonst ließe sich die Extension/Magic-Byte-
Konsistenzprüfung aus `upload_finalize` nachträglich unterlaufen. Live
verifiziert: Rename einer PDF auf einen neuen `.pdf`-Namen erfolgreich,
Rename derselben PDF auf einen `.txt`-Namen klar abgelehnt.

**Zusätzlich:** `capabilities.processors` liefert jetzt
`{id, supported_mime_categories}` statt nur IDs (`listProcessorsWithCategories()`)
— ein Client sieht direkt, welcher Processor zu welcher Datei passt.
`USAGE_STEPS` entsprechend aktualisiert (job_list, rename erwähnt).

**Getestet:** Vollständiger Live-E2E-Durchlauf gegen beide laufenden
Prozesse (Upload Text/PDF/PNG → Mismatch-Ablehnung → alle 5 Processor →
job_list → rename erlaubt/abgelehnt → health_get-Storage → capabilities_get-
Schema). 20 neue automatisierte Tests (`test/processors.test.ts` neu, 10
neue in `test/store.test.ts`) — jetzt **15 Tools, 5 Processor, 64
automatisierte Tests, alle grün**; `npm run check` fehlerfrei.

**Doku aktualisiert:** `docs/ARCHITECTURE.md` (Processor-Registry-Tabelle,
Tool-Vertragstabelle, Health/Doctor-Storage-Absatz, Rename-Absatz,
Diagramm 13→15 Tools), `docs/SECURITY.md` (neue Abschnitte
"Abhängigkeits-/Supply-Chain-Entscheidung: pdfjs-dist", Prepare-Zeit-
Mime-Check-Ergänzung), `README.md`, `docs/VERSIONING.md`,
`docs/HANDOFF.md`.

## 2026-09-11 — Cascade Delete, Staging-Reaper, CORS entfernt

Fortsetzung des letzten Verbesserungsvorschlags — drei konkrete Funde aus
einer erneuten Codedurchsicht umgesetzt:

**1. Löschung war unvollständig (Datenlebenszyklus-Bug).**
`rheinagent_file_delete_apply` entfernte nur Datei + `FileRecord`, nie die
zugehörigen `JobRecord`s oder ihre gespeicherten Ergebnisse. Bei
`text_uppercase` ist das Ergebnis der komplette transformierte
Dateiinhalt — der blieb nach "Löschung" der Quelldatei unbegrenzt über
`rheinagent_file_result_get` abrufbar. Neue Funktion
`cascadeDeleteJobsForFile()` (`src/lib/store.ts`), in `applyDelete()`
eingehängt: entfernt jetzt jeden Job (und dessen Ergebnisdatei unter
`data/results/`) für die gelöschte Datei mit.

**2. Verwaiste Staging-Bytes (unbegrenztes Plattenwachstum).**
`getPendingUpload()` löschte bei Ablauf (15 min TTL) nur den JSON-
Metadaten-Eintrag, nie die tatsächlich gestagten Bytes unter
`data/staging/` — ein PUT ohne folgendes `upload_finalize` hinterließ die
Datei für immer. Neue Funktion `sweepOrphanedStaging()` (`src/lib/store.ts`):
entfernt jede gestagte Datei ohne noch gültigen Pending-Upload-Eintrag und
räumt abgelaufene Metadaten-Einträge proaktiv auf. Aufgerufen einmal beim
Start der Control Plane und danach alle 15 Minuten (`setInterval`, `unref()`d).

**3. CORS unnötig offen.** `cors()` lief ohne Origin-Einschränkung auf der
Control Plane, obwohl kein legitimer MCP-Client (Agent-Prozess, curl,
Client-Bibliothek) je einen `Origin`-Header sendet — die einzige Wirkung
war Angriffsfläche für eine bösartige Webseite im lokalen Browser des
Betreibers gegen `localhost:3901`. `cors`/`@types/cors` komplett aus
`package.json` entfernt (`npm uninstall`).

**Getestet:**
- Live end-to-end: vollständiger Upload→Process(`text_uppercase`)→
  `result_get`(zeigt Inhalt)→Delete-Flow bestätigt Cascade-Verhalten am
  Store-Layer (die MCP-Elicitation-Bestätigung selbst ließ sich über
  reines Raw-curl ohne `initialize`-Handshake nicht auslösen — unabhängig
  von dieser Änderung, bereits vorher bekanntes Test-Tooling-Detail).
  Reaper live verifiziert: künstlich verwaiste Staging-Datei + abgelaufener
  Metadaten-Eintrag angelegt, Control Plane neu gestartet →
  `"staging sweep","removed_files":1,"removed_entries":1"` geloggt, beides
  danach nachweislich weg.
- CORS live verifiziert: `curl` mit `Origin: http://evil.example` gegen
  `/mcp` liefert keinen `Access-Control-Allow-Origin`-Header mehr (vorher
  reflektiert).
- 4 neue automatisierte Tests in `test/store.test.ts` (2× Cascade-Delete,
  2× Staging-Reaper) — jetzt **48 automatisierte Tests**, `npm run check`
  fehlerfrei.

**Doku aktualisiert:** `docs/SECURITY.md` (neue Abschnitte "Kein CORS
(bewusst)", "Vollständigkeit der Löschung", "Keine verwaisten Upload-
Bytes"), `docs/ARCHITECTURE.md` (Read/Prepare/Apply/Verify-Tabelle,
Staging/Quarantine-Abschnitt).

## 2026-09-11 — Tool-Vertrags-Audit + LLM-Erklärbarkeit + Workflow-Script

Auftrag: sicherstellen, dass alle Tools korrekte Beschreibungen/Verträge
haben, recherchieren, wie ein `capabilities`-Tool einem LLM die Funktionen
erklären sollte (und ob das umgesetzt werden soll), und weitere
Verbesserungen für MCP + Workflow vorschlagen.

**Vertrags-Audit-Ergebnis (alle 13 Tools durchgesehen):** Annotations
(`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`) und
Rate-Limit-Klassen passten bereits konsistent zum tatsächlichen Verhalten.
Zwei echte Lücken gefunden und behoben:

1. **Wire-Format-Inkonsistenz.** `FileRecordSchema`/`JobRecordSchema`/
   `DeleteTicketResultSchema` gaben bisher `camelCase` zurück (direkt aus
   den internen `store.ts`-Records gespreadet), obwohl jedes Tool-Input-
   Feld und `UploadPrepareResultSchema`/`DownloadPrepareResultSchema`
   bereits `snake_case` waren — zwei Konventionen im selben öffentlichen
   Vertrag. Neuer Mapping-Layer `src/lib/wire.ts`
   (`toWireFile()`/`toWireJob()`/`toWireDeleteTicket()`); jeder
   `structuredContent`-Rückgabewert läuft jetzt dadurch. Bewusst als
   Breaking-Change vor jeder echten Kunden-Integration bereinigt (siehe
   `docs/VERSIONING.md` Schema-Kompatibilität — genau der richtige
   Zeitpunkt dafür).
2. **ID-Eingaben nur lose typisiert.** `file_id`/`job_id`/`upload_id`/
   `delete_token` waren `z.string()` ohne Formprüfung — eine falsche ID
   scheiterte dadurch als generischer "internal error in `<tool>`" statt
   als klare Validierungsmeldung (Ursache: `assertOpaqueId()` wirft erst
   tief in `store.ts`). Neue Per-Kind-Feldschemas `FileIdField`/
   `JobIdField`/`UploadIdField`/`DeleteTokenField` (`src/lib/schemas.ts`,
   gebaut aus neu exportiertem `idPattern()`/`ID_PREFIXES` in
   `src/lib/ids.ts`) — lehnen jetzt auch eine ID der falschen Art ab (z. B.
   ein `job_id`-Wert an `file_id` übergeben), nicht nur beliebige Strings.

**Recherche „capabilities-Tool für LLM-Erklärbarkeit“:** Im MCP-SDK
(`@modelcontextprotocol/server`) gefunden: `ServerOptions.instructions`
(String, Teil der `initialize`-Antwort) ist laut Typdefinition genau dafür
vorgesehen — "Optional instructions describing how to use the server and
its features" — wurde von diesem Produkt aber nie gesetzt. Das ist der
spec-eigene Mechanismus, nicht das selbstgebaute
`rheinagent_file_capabilities_get`. Umgesetzt:
- `server.ts`: `new McpServer(serverInfo, { instructions: SERVER_INSTRUCTIONS })`
  — kompakte Workflow-Kurzanleitung (Discover → Upload → Inspect → Process
  → Delete, IDs sind opak), erreicht das Modell einmal pro Session ohne
  Tool-Call.
- Da nicht jeder MCP-Client `instructions` an das Modell durchreicht:
  redundant auch als neues `usage`-Feld in
  `rheinagent_file_capabilities_get`s Antwort (Klartext-Content **und**
  `structuredContent`), da viele Agent-Frameworks dieses Tool ohnehin früh
  aufrufen. Beide Quellen kommen aus derselben Konstante `USAGE_STEPS`
  (`src/lib/capabilities.ts`), damit sie nicht auseinanderlaufen.
- Zusätzlich `capabilities.limits.rate_limit_window_ms`/
  `rate_limits_per_window` ergänzt (aus `src/lib/rateLimit.ts` exportiert)
  — ein Client kennt sein Pacing-Budget vorab statt erst über einen
  `rate limit exceeded`-Fehler.

**Workflow-Verbesserung:** neues `npm run check` (= `tsc --noEmit` + `npm
test`) bündelt das komplette `docs/VERSIONING.md`-Release-Gate in einem
Befehl statt zwei manuell zu merkenden Kommandos.

**Getestet:** Live end-to-end — `initialize`-Antwort trägt `instructions`,
`capabilities_get` trägt `usage` + Rate-Limit-Felder, `upload_finalize`/
`get` liefern durchgängig `snake_case`, eine `job_id` als `file_id` und ein
Path-Traversal-String scheitern beide als klare `Input validation error`
statt internal error. 12 neue automatisierte Tests (`test/contracts.test.ts`
für ID-Felder + Wire-Mapper, `test/capabilities.test.ts` — vorher komplett
ungetestetes Modul) — jetzt **44 automatisierte Tests**, `npm run check`
fehlerfrei. Tool-Anzahl unverändert bei 13 (reine Vertragsverbesserung).

**Doku aktualisiert:** `docs/ARCHITECTURE.md` (neue Absätze: Wire-
Konvention, ID-Validierung, Instructions/Usage-Pattern, Rate-Limit-Feld),
`README.md`, `docs/HANDOFF.md`, `docs/VERSIONING.md` (Release-Gate nutzt
jetzt `npm run check`).

## 2026-09-11 — Bind-Host-Fix (loopback-only) + Health/Doctor-Tool

Auf Anfrage: Verbesserungen für den MCP durchdacht (Bind-Host-Lücke,
CI-Workflow, Health/Doctor-Tool, Testlücken in `audit.ts`/`jsonIndex.ts`,
Docker-Setup). Nutzer hat CI für diese Runde zurückgestellt und
Health/Doctor priorisiert.

**Sicherheitsfix — Bind-Host-Standard:**
- `server.ts` und `dataplane.ts` riefen `app.listen(PORT, ...)` bisher ohne
  Host auf, was bei Express/Node `0.0.0.0` bedeutet — auf `berry` (Pi im
  Tailnet/LAN) waren beide HTTP-Planes damit netzwerkweit erreichbar, obwohl
  diese Version laut `docs/SECURITY.md` bewusst kein TLS/Auth auf
  HTTP-Ebene hat.
- Neue Env-Var `RHEINAGENT_FILE_UPLOAD_BIND_HOST`, Default `127.0.0.1`, für
  beide Prozesse. Verifiziert per `ss -ltnp`: vorher `*:3902` (wildcard),
  danach `127.0.0.1:3901`/`127.0.0.1:3902`.

**Neues Tool: `rheinagent_file_health_get`** (Health-Profil
`rheinagent-file-upload-v1`, Konzept aus `docs/VERSIONING.md` erstmals
implementiert):
- `control_plane_reachable` (trivial `true`), `data_plane_reachable` (neuer
  `GET /healthz`-Endpunkt auf der Data Plane, 2 s Timeout),
  `staging_dir_writable`/`files_dir_writable` (`fs.access(dir, W_OK)`,
  hinterlässt keine Probe-Datei).
- Im `hub`-Audit-Modus zusätzlich: `endpoint_configured`/
  `service_id_configured`/`credential_path_configured` (nur ob gesetzt, nie
  die Werte) sowie `hub_endpoint_reachable` — neue Funktion
  `checkHubEndpointReachable()` in `src/lib/audit.ts`, bewusst ein
  protokoll-loser reiner Netzwerk-Reachability-Check (kein Credential im
  Request), **kein** Ersatz für die weiterhin offene Audit-Hub-Live-
  Verifikation des Write-Ahead-Vertrags selbst.
- `status: "ok"|"degraded"` — `degraded` sobald irgendeine Einzelprüfung
  negativ ausfällt.

**Getestet:**
- Live end-to-end in drei Zuständen: beide Planes hoch → `status: "ok"`,
  `data_plane_reachable: true`; Data Plane gestoppt → `status: "degraded"`,
  `data_plane_reachable: false`; `RA_AUDIT_MODE=hub` mit absichtlich
  unerreichbarem Endpoint (`http://127.0.0.1:9999`) → `status: "degraded"`,
  `hub_endpoint_reachable: false`, Config-Flags korrekt `true`, keine
  Credentials im Output.
- 6 neue automatisierte Tests: `test/audit.test.ts` (neu, 5 Tests für
  `loadAuditConfig`/`checkHubEndpointReachable` inkl. env-Isolation) + 1
  neuer Test in `test/store.test.ts` für die Verzeichnis-Schreibbarkeits-
  Helfer. Insgesamt jetzt **13 Tools, 36 automatisierte Tests, alle grün**;
  `npx tsc --noEmit` fehlerfrei.

**Doku aktualisiert:** `docs/ARCHITECTURE.md` (Bind-Host-Absatz + neue
"Health / Doctor"-Sektion + Tool-Vertragstabelle + Diagramm-Update auf 13
Tools), `docs/SECURITY.md`, `docs/AUDIT.md` (Allowlist-Tabelle),
`docs/VERSIONING.md` (Health/Doctor-Konzept als implementiert markiert,
Release-Gate-Toolzahl), `docs/INSTALLATION.md` (neue Env-Var, Doctor-
Abschnitt), `README.md`, `docs/HANDOFF.md` (beide Punkte aus "offen"
entfernt, CI-Zurückstellung dokumentiert, Prioritätenliste neu sortiert).

## 2026-09-11 — Download-Endpunkt für große/binäre Dateien

Nächster unblockierter Punkt aus `docs/HANDOFF.md`s Prioritätenliste:
Audit-Hub-Live-Verifikation (Punkt 1) hängt an einer Cross-Repo-
Registrierung in `rheinagent-audit`, die laut HANDOFF ausdrücklich nicht in
diesem Repo erledigt wird, und diese Session hatte keinen konfigurierten
Zugriff auf eine laufende Hub-Instanz. Stattdessen umgesetzt: der bisher
fehlende Download-Pfad für Dateien, die `rheinagent_file_get` nicht inline
liefert (alles über 64 KiB bzw. nicht-Text).

**Neu:**
- `newDownloadToken()` (`src/lib/ids.ts`, Präfix `dl_`).
- `DownloadTicket` + `createDownloadTicket()`/`getDownloadTicket()`
  (`src/lib/store.ts`, `data/meta/downloads.json`) — 15 min TTL, bewusst
  **wiederverwendbar** innerhalb der TTL (anders als der Einweg-
  `delete_token`), weil ein `GET` laut `readOnlyHint`-Konvention idempotent
  sein muss. `createDownloadTicket` weist Dateien ab, die nicht existieren
  oder `pendingDelete` sind.
- Tool `rheinagent_file_download_prepare` (Control Plane, `write`-
  Gewichtsklasse wie `upload_prepare`/`delete_prepare`) liefert
  `download_token` + `download_url` gegen die Data Plane.
- `GET /download/:downloadToken` (Data Plane, `dataplane.ts`) löst das
  Token auf, liest ausschließlich über `filePath()` (opake, bereits
  validierte Pfade unter `data/files/`) und streamt mit
  `Content-Disposition: attachment`. Unbekannter/abgelaufener Token → `404`,
  inzwischen gelöschte Datei → `410`.
- `DownloadPrepareResultSchema` (`src/lib/schemas.ts`).

**Getestet:**
- Live end-to-end gegen beide laufenden Prozesse (Control Plane Port 3901,
  Data Plane Port 3902) per direktem JSON-RPC + HTTP: Upload → Finalize →
  Download-Prepare → GET, inkl. Token-Wiederverwendung (zweiter GET mit
  demselben Token → `200`), unbekannter Token (`404`) und
  Download-Prepare-Ablehnung für eine `pendingDelete`-Datei.
- 4 neue automatisierte Tests in `test/store.test.ts` (Round-Trip,
  unbekanntes Token, unbekannte `file_id`, `pendingDelete`-Ablehnung) —
  insgesamt jetzt **30 Tests, alle grün**; `npx tsc --noEmit` fehlerfrei.

**Doku aktualisiert:** `docs/ARCHITECTURE.md` (neue "Download"-Sektion +
Tool-Vertragstabelle), `docs/SECURITY.md` (Trust-Grenzen + "bekannte
Grenzen"), `docs/AUDIT.md` (Allowlist-Tabelle), `docs/VERSIONING.md`
(Release-Gate: 11→12 Tools), `README.md`, `docs/HANDOFF.md` (Download-Punkt
aus "offen" entfernt, Prioritätenliste neu sortiert, Hinweis auf fehlenden
Audit-Hub-Zugriff in dieser Session ergänzt).

## 2026-09-11 — Echte Protokoll-2026-07-28-Konformität + MCP-Spec-Nachrüstung

Nach Abgleich mit der offiziellen MCP-Dokumentation festgestellt: Das bis
eben genutzte `@modelcontextprotocol/sdk@1.30.0` unterstützte nur bis
Protokoll `2025-11-25` — das im Produktbriefing geforderte Zielprotokoll
`2026-07-28` wurde trotz `capabilities_get`-Angabe technisch nicht
eingehalten. Komplettumstellung auf die neue v2-Paketlinie plus Nachrüstung
mehrerer von der Spec verlangter/empfohlener Mechanismen, die vorher fehlten.

**SDK-Migration:**
- `@modelcontextprotocol/sdk` entfernt, ersetzt durch `@modelcontextprotocol/server`
  + `@modelcontextprotocol/node` (v2.0.0)
- `createMcpHandler()` + `toNodeHandler()` bedienen Legacy- (`initialize`-Handshake,
  z. B. `2025-06-18`) und moderne (`2026-07-28`, stateless, `_meta`-basiert)
  Clients über denselben `/mcp`-Endpunkt
- Alle `registerTool`-Aufrufe auf zod-Objekt-Schemas (`inputSchema`/`outputSchema`)
  statt Raw-Shapes umgestellt; `outputSchema` pro Tool neu (`src/lib/schemas.ts`)
  macht `structuredContent` clientseitig validierbar
- Tool-`annotations` (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`)
  für alle 11 Tools ergänzt

**Neue, parallel per Fork gebaute Module** (unabhängig, dann selbst integriert):
- `src/lib/rateLimit.ts` — Rate-Limiting pro Tool-Name, 3 Gewichtsklassen
  (read/write/critical), env-konfigurierbar. Vorher: 0 % Rate-Limiting trotz
  Spec-Pflicht ("servers MUST rate limit tool invocations").
- `src/lib/logging.ts` — strukturiertes stderr-JSON-Logging statt `console.log`.
  Wichtiger Fund dabei: die MCP-`notifications/message`-Logging-Utility ist in
  `2026-07-28` deprecated (SEP-2577) — bewusst nicht darauf gesetzt.

**Selbst umgesetzt:**
- Pagination für `rheinagent_file_list` (`cursor`/`next_cursor`, deterministische
  Sortierung nach `createdAt`+`fileId`) — verhindert unbegrenztes Wachstum
  durch MCP-JSON bei vielen Dateien
- Elicitation-Bestätigung vor `rheinagent_file_delete_apply`: ohne akzeptierte
  `confirm: true`-Antwort liefert das Tool `InputRequiredResult`
  (`resultType: "input_required"`), die Datei bleibt unverändert. Erster
  echter Multi-Round-Trip-Flow in diesem Produkt.

**Getestet (end-to-end, nicht nur Unit-Tests):**
- Legacy-`initialize` (`2025-06-18`) weiterhin funktionsfähig
- Moderner stateless `2026-07-28`-Request (`_meta`, `Mcp-Method`/`Mcp-Name`-Header)
  für `tools/list` und `tools/call` — inkl. automatisch generierter
  `outputSchema`/`annotations` in der `tools/list`-Antwort
  (`resultType: "complete"`, `cacheScope`)
- Vollständiger Upload-Flow unter dem neuen Protokoll
- Delete-Flow inkl. `MissingRequiredClientCapabilityError` (-32021) wenn
  `elicitation`-Capability fehlt, `input_required` ohne Bestätigung, echte
  Löschung erst nach akzeptierter Bestätigung
- Pagination (3 Dateien hochgeladen, `limit=2` → korrekte 2 Seiten mit/ohne `next_cursor`)
- 26 automatisierte Tests (13 bestehend + 5 Rate-Limit + 8 Logging), alle grün;
  `npx tsc --noEmit` fehlerfrei

**Aufgeräumt:** `@modelcontextprotocol/sdk`, `@modelcontextprotocol/express`
(nie genutzt) aus den Dependencies entfernt.

**Bewusst zurückgestellt:** Resource-Exposure (`resources/list`/`read` für
Dateien zusätzlich zu den Tools) — additiv, nicht sicherheitskritisch, siehe
`docs/HANDOFF.md`.

## 2026-09-11 — Produkt-Neuausrichtung: RheinAgent File Upload MCP

Vollständige Neuausrichtung von der UI-Test-Prototyp-Phase auf das offizielle
Produktbriefing (Protokoll `2026-07-28`, Package-v2-Profil
`rheinagent-file-upload@1`). Referenz-Repos (Manager/License/Update-Feed/
Audit/Knowledge/Backoffice) per Fork-Recherche auf aktuellem `main`-Stand
gelesen, exakte Verträge extrahiert (siehe `docs/HANDOFF.md` für die
gelesenen Commit-SHAs).

**Architektur:**
- Control Plane (`server.ts`, Port 3901) und Data Plane (`dataplane.ts`,
  Port 3902) als getrennte Prozesse — rohe Datei-Bytes laufen nie durch
  MCP-JSON
- Opake IDs (`src/lib/ids.ts`) für `file_id`/`job_id`/`upload_id`/
  `delete_token` — Path-Traversal strukturell ausgeschlossen, nicht nur
  sanitisiert
- Staging/Quarantine: Bytes landen erst in `data/staging/`, werden bei
  `upload_finalize` validiert und erst dann atomar nach `data/files/`
  verschoben
- Validierung: Größenlimit, Extension-Allowlist, Magic-Byte-Sniffing
  unabhängig von der deklarierten Extension, SHA-256-Hash
  (`src/lib/security.ts`)
- Archiv-Formate (`.zip` etc.) werden komplett abgelehnt statt entpackt —
  Archive-Bomb-Risiko dadurch strukturell ausgeschlossen
- Processor-Registry (`src/lib/processors.ts`) statt beliebigem Executor —
  aktuell `text_stats`, `text_uppercase`
- Read/Prepare/Apply/Verify durchgängig: Upload-, Process- und
  Delete-Flows haben je einen reversiblen Prepare- und einen tatsächlich
  mutierenden Apply-Schritt
- Audit-Client (`src/lib/audit.ts`) nach `RA_AUDIT_MODE=off|hub`-Vertrag,
  content-free/allowlist-only, Write-Ahead mit Fail-Closed für kritische
  Schreiboperationen — implementiert, aber noch nicht gegen eine laufende
  Hub-Instanz verifiziert (siehe `docs/HANDOFF.md`)
- Alle 11 vorgesehenen Tools implementiert: `rheinagent_file_capabilities_get`,
  `_upload_prepare`, `_upload_finalize`, `_list`, `_get`, `_process_prepare`,
  `_process_apply`, `_job_get`, `_result_get`, `_delete_prepare`, `_delete_apply`

**Entfernt:** der bisherige UI-Test-Prototyp (`mcp-app.html`,
`src/mcp-app.ts`, `vite.config.ts`, `@modelcontextprotocol/ext-apps`) — neue
Tool-Namen sind nicht kompatibel dazu, UI ist laut Vorgabe optional und wird
als späteres Fast-Follow behandelt (siehe `docs/HANDOFF.md`).

**Getestet:**
- Kompletter Upload-Flow (prepare → PUT → finalize) end-to-end per
  direktem JSON-RPC + HTTP
- Process-Flow (prepare → apply → job_get → result_get) end-to-end
- Delete-Flow (prepare → apply) end-to-end
- Security-Negativtest: als `.txt` deklariertes PNG wird bei `upload_finalize`
  korrekt abgelehnt (Magic-Byte-Mismatch)
- Security-Negativtest: ungültige `file_id` (`../../etc/passwd`) wird vor
  jedem Dateisystemzugriff abgewiesen
- 13 automatisierte Tests unter `test/security.test.ts` (`npm test`), alle grün
- **Echter Bug gefunden und behoben:** `JsonIndex` cachte pro Prozess — da
  Control- und Data-Plane laut Architektur bewusst getrennte Prozesse sind,
  sah die Data Plane neu angelegte `upload_id`s aus der Control Plane nicht.
  Fix: jede Operation liest jetzt frisch von Platte statt aus einem
  In-Memory-Cache (siehe `src/lib/jsonIndex.ts`)

**Dokumentation neu angelegt:** `README.md`, `docs/ARCHITECTURE.md`,
`docs/SECURITY.md`, `docs/AUDIT.md`, `docs/LICENSE-FLOW.md`,
`docs/INSTALLATION.md`, `docs/VERSIONING.md`, `docs/HANDOFF.md`.

**Offen (vollständige Liste in `docs/HANDOFF.md`):** Audit-Hub-Live-Test,
License/Manager/Update-Feed-Registrierung, Download-Endpunkt für große/
binäre Dateien, Health/Doctor-Tool, Docker-Setup, UI-Wiederanbindung.

## 2026-09-11 — Persistenz auf Platte

- Dokumentenspeicher aus reinem In-Memory-`Map` in `store.ts` ausgelagert
- Schreibt bei jeder Änderung (`upload`, `edit`, `delete`) nach `data/documents.json`
- Lädt beim Serverstart vorhandene Dokumente von Platte (`loadStore()`)
- `data/` ist in `.gitignore` — Nutzerdokumente landen nie im Repo
- Verifiziert: Upload → Server-Neustart → `list_documents` zeigt das Dokument weiterhin
- Bekannte Grenzen: kein Multi-User-/Session-Schutz (alle Clients teilen sich
  dieselbe Datei), keine Größenbegrenzung, keine Verschlüsselung

## 2026-09-11 — RheinAgent-Branding + Löschen/Mehrfach-Upload

- Farben/Schrift/Logo aus `brand_tokens.css`/`.json` (RheinAgent-Designpaket) ins Widget übernommen
- Neues Tool `delete_document`
- Mehrfach-Datei-Upload im Widget (mehrere Dateien in einem Durchgang)
- "Zusammenfassen"-Button im Dokument-Viewer (manueller Re-Trigger ohne Re-Upload)
- Getestet: alle 5 Tools per direktem JSON-RPC (upload/list/view/edit/delete)

## 2026-09-11 — Erstversion: Dokument-Upload + LLM-Kontext-Push

- MCP-App-Server nach SEP-1865 (MCP Apps) mit `@modelcontextprotocol/ext-apps`
- Tools `upload_document`, `list_documents`, `get_document`, `edit_document`,
  alle an dieselbe `ui://documents/mcp-app.html`-Resource gekoppelt
- Widget: Upload-Drop-Zone, Dokumentliste, Viewer, Download (`app.downloadFile`)
- `app.updateModelContext()` + `app.sendMessage()` zum automatischen Anstoßen
  einer Zusammenfassung im Chat nach Upload
- Live in Claude Desktop (remote) getestet via `cloudflared`-Tunnel und
  Tailscale Funnel — Rendering + Interaktivität bestätigt
- Repo initial gepusht: `github.com/Codeelchi/rheinagent-file-upload`
