# State Migration: JSON → SQLite

Stand: 2026-09-11.

## Entscheidung

Metadaten (`PendingUpload`/`FileRecord`/`JobRecord`/`DeleteTicket`/
`DownloadTicket`) liegen jetzt in einer SQLite-Datenbank
(`data/meta/state.sqlite`, WAL-Modus) statt in fünf einzelnen
Whole-File-JSON-Dateien (`data/meta/*.json`).

**Kein neues Abhängigkeitsproblem**: verwendet wird Node's eingebautes
`node:sqlite` (stabil ab Node 22, keine zusätzliche `package.json`-
Dependency, kein natives Addon) statt `better-sqlite3` — dieselbe
Begründung wie die `pdfjs-dist`-statt-`pdf-parse`-Entscheidung in
[SECURITY.md](SECURITY.md): kein kompilierter nativer Code auf einem
arm64-On-Prem-Host.

## Warum

Die vorherige `JsonIndex`-Implementierung (`src/lib/jsonIndex.ts`, jetzt
entfernt) las bei jedem Zugriff die komplette Tabellendatei, änderte sie im
Speicher und schrieb sie per `fs.rename()` atomar komplett neu. Das ist
atomar pro Schreibvorgang, aber **nicht** serialisiert zwischen zwei
Prozessen: Control Plane und Data Plane sind laut
[ARCHITECTURE.md](ARCHITECTURE.md) bewusst getrennte OS-Prozesse, die
beide dieselbe `uploads`-Tabelle lesen/schreiben. Zwei nahezu gleichzeitige
`set()`-Aufrufe auf denselben Datensatz aus unterschiedlichen Prozessen
konnten sich gegenseitig überschreiben ("last write wins", explizit als
bekannte Grenze in [SECURITY.md](SECURITY.md) dokumentiert). SQLite im
WAL-Modus serialisiert konkurrierende Schreiber über echtes Datei-Locking
und lässt Leser nie blockieren — das schließt genau diese Race, ohne einen
externen DB-Server oder eine dritte Prozesskomponente einzuführen.

## Was NICHT gemacht wurde

- **Kein relationales Schema mit Foreign Keys** zwischen den fünf
  Tabellen. Jede Tabelle ist weiterhin `(id TEXT PRIMARY KEY, value TEXT)`
  — derselbe Key-Value-JSON-Blob wie vorher, nur SQLite-backed statt
  Datei-backed. Das behält den bestehenden `store.ts`-Vertrag (jede
  Tabelle ist ein einfacher `get`/`values`/`set`/`delete`-Store) exakt bei
  und minimiert das Risiko dieser Migration, statt gleichzeitig ein neues
  relationales Datenmodell einzuführen. Ein echtes relationales Schema
  (z. B. `jobs.file_id` als Foreign Key auf `files.id`) ist ein separater,
  bewusst nicht in dieser Runde getroffener nächster Schritt.
- **Kein Schema-Versions-/Migrationsframework.** Bei nur fünf simplen
  Key-Value-Tabellen ohne Spaltenschema wäre das verfrühte Komplexität;
  `CREATE TABLE IF NOT EXISTS` pro Tabellenname reicht aktuell aus.

## Migration bestehender Daten

`migrateLegacyJsonMetadata()` (`src/lib/store.ts`, aufgerufen von
`ensureDirs()` bei jedem Start) importiert für jede Tabelle eine
gleichnamige, noch vorhandene `data/meta/<table>.json`-Datei automatisch
in die jetzt leere/neue SQLite-Tabelle und benennt die JSON-Datei danach
zu `<table>.json.migrated` um (kein Datenverlust, kein stilles Löschen).
Läuft **nur**, wenn die Zieltabelle noch leer ist — bereits migrierte oder
unabhängig neu entstandene SQLite-Daten werden nie überschrieben. Idempotent,
damit ein Neustart nach einem fehlgeschlagenen/partiellen Migrationslauf
sicher ist.

Live end-to-end verifiziert: eine handgeschriebene `files.json` im
`JsonIndex`-Altformat wurde per `ensureDirs()`/`migrateLegacyJsonMetadata()`
korrekt importiert (`migrated: { files: 1 }`), per direkter SQLite-Abfrage
als vorhanden bestätigt, und die Quelldatei lag danach als
`files.json.migrated` vor. Da `data/` in diesem Repo nirgendwo eingecheckt
ist (siehe `.gitignore`), betraf das ausschließlich lokale Testdaten dieser
Session — keine echten Kundendaten existieren zu diesem Zeitpunkt.

## Automatisierte Tests

`test/sqliteIndex.test.ts` (10 Tests, ersetzt das vorherige
`test/jsonIndex.test.ts`) deckt denselben Verhaltensvertrag ab
(get/values/set/delete, Verzeichnis-Anlage, Cross-Instanz-Sichtbarkeit ohne
Cache) plus SQLite-spezifische Fälle (mehrere Tabellen in derselben Datei
sind unabhängig, Migration importiert/benennt um, Migration überschreibt
keine bereits vorhandenen Zeilen).

## Bekannte Grenzen dieser Version (unverändert ggü. vorher)

Kein verteiltes Locking über mehrere Hosts — für Einzelbetrieb (Control-/
Data-Plane auf demselben Host, wie in [ARCHITECTURE.md](ARCHITECTURE.md)
beschrieben) gedacht.
