# Security

## Trust-Grenzen

- MCP-Clients sind nicht vertrauenswürdig bezüglich Dateiinhalt, Dateiname
  und deklarierter Größe — jede Angabe wird serverseitig erneut geprüft.
- Die Control Plane vertraut der Data Plane nur insoweit, dass sie Bytes
  unverändert unter dem vorgesehenen `upload_id`-Pfad ablegt; die eigentliche
  Validierung (Magic-Bytes, Größe, Extension-Konsistenz) passiert
  ausschließlich in der Control Plane (`upload_finalize`), nie in der Data
  Plane selbst.
- Downloads laufen spiegelbildlich: die Data Plane serviert `GET
  /download/:downloadToken` ungeprüft gegen den Dateiinhalt — Autorisierung
  passiert ausschließlich durch Besitz eines gültigen, befristeten Tokens,
  das nur die Control Plane (`rheinagent_file_download_prepare`) ausstellt
  und das dabei bereits prüft, dass die Datei existiert und nicht
  `pendingDelete` ist.
- Der zentrale Audit Hub (falls `RA_AUDIT_MODE=hub`) ist ein separater
  Trust-Boundary-Partner mit eigenem Service-Credential — siehe [AUDIT.md](AUDIT.md).

## Kein CORS (bewusst)

Beide HTTP-Planes senden **keine** `Access-Control-Allow-*`-Header (bis
2026-09-11 lief `cors()` ohne Origin-Einschränkung auf der Control Plane —
entfernt). Reale MCP-Clients (ein Agent-Prozess, `curl`, eine MCP-Client-
Bibliothek) senden nie einen `Origin`-Header und sind von CORS-Regeln
unberührt — die einzige praktische Wirkung eines permissiven `cors()` wäre
gewesen, dass eine im lokalen Browser des Betreibers geöffnete bösartige
Webseite per `fetch()` gegen `localhost:3901`/`3902` sprechen könnte
(klassischer Angriffsvektor gegen unauthentifizierte lokale Dienste,
ergänzend zum Loopback-Bind unten). Da kein legitimer Client CORS braucht,
war das reine unnötige Angriffsfläche.

## Opake IDs statt Pfaden (`src/lib/ids.ts`)

Jede Tool-Eingabe, die eine Ressource adressiert (`file_id`, `job_id`,
`upload_id`, `delete_token`), ist ein server-generiertes `<prefix>_<uuid>`.
`assertOpaqueId()` prüft dieses Format **bevor** die ID je als
Dateisystem-Pfadsegment verwendet wird. Nutzereingaben wie `../../etc/passwd`
werden dadurch strukturell abgewiesen, nicht nur durch Sanitizing — siehe
Testfall in [BUILDLOG.md](../BUILDLOG.md).

## Path-Traversal- und Symlink-Schutz (`src/lib/security.ts`)

- `safeJoin()` löst jeden Pfad auf und verifiziert zusätzlich, dass das
  Ergebnis innerhalb des Basisverzeichnisses liegt (Verteidigung in der
  Tiefe, auch falls `assertOpaqueId` künftig umgangen würde).
- `assertNotSymlink()` prüft vor jedem Schreib-/Umbenennungsziel per
  `fs.lstat`, ob dort bereits ein Symlink liegt, und bricht ab. Da alle
  Zielpfade ausschließlich aus unseren eigenen opaken IDs gebildet werden,
  ist ein dort gefundener Symlink immer ein Anomalie-Signal.

## Upload-Validierung (Staging → Finalize)

Bei `rheinagent_file_upload_finalize` werden **alle** folgenden Prüfungen
durchlaufen, bevor eine Datei die Quarantine verlässt:

1. **Deklarierte Größe** (`upload_prepare`) ≤ `RHEINAGENT_FILE_UPLOAD_MAX_BYTES`
2. **Tatsächliche Staging-Größe** ≤ demselben Limit (die Data Plane bricht
   zusätzlich bereits während des Streams ab, sobald das Limit überschritten wird)
3. **Extension-Allowlist** (`classifyExtension`) — nur `.txt .md .csv .json
   .pdf .png .jpg .jpeg .docx .xlsx`
4. **Magic-Byte-Sniffing** (`sniffMimeCategory`) der tatsächlichen Bytes,
   unabhängig von der deklarierten Extension. Für `.docx`/`.xlsx` reicht der
   ZIP-Magic-Byte (`PK\x03\x04`) allein nicht — `sniffMimeCategory` prüft
   zusätzlich per bounded Unzip (`src/lib/officeZip.ts`), ob `[Content_Types].xml`
   tatsächlich einen `wordprocessingml.document.main`- bzw.
   `spreadsheetml.sheet.main`-Content-Type deklariert. Ein einfaches, auf
   `.docx` umbenanntes `.zip` bleibt dadurch als `archive` klassifiziert und
   scheitert an Prüfung 5 unten, statt als `office` durchzurutschen.
5. **Konsistenzprüfung**: deklarierte Kategorie muss der gesniffelten
   Kategorie entsprechen — ein als `.txt` deklariertes PNG wird abgelehnt
   (verifizierter Testfall, siehe [BUILDLOG.md](../BUILDLOG.md))
6. **SHA-256-Hash** wird berechnet und in den Metadaten gespeichert (Grundlage
   für künftige Integritäts-/Dedup-Prüfungen, aktuell nicht gegen einen
   externen Referenzwert verglichen)

## Archive-Bomb-Grenzen

Generische Archivformate (`.zip .tar .gz .7z .rar`) werden weiterhin
**grundsätzlich abgelehnt**, nicht größenbeschränkt entpackt — für alles
außer den beiden unten beschriebenen OOXML-Formaten bleibt das
Archive-Bomb-Risiko strukturell ausgeschlossen, nicht durch eine
Kompressionsverhältnis-Heuristik gemindert.

**`.docx`/`.xlsx` sind seit 2026-09-11 die einzige Ausnahme** — beide sind
intern ZIP-Container (OOXML), aber echte Zielformate für Dokumentenanalyse
(siehe [PROCESSORS.md](PROCESSORS.md)). `src/lib/officeZip.ts` implementiert
dafür einen eigenen, bewusst eingeschränkten ZIP-Reader statt eines
allgemeinen Entpack-Processors:

- **Kein Schreiben auf die Platte.** Entpackte Inhalte bleiben ausschließlich
  im Prozessspeicher — Entry-Namen werden nie als Dateisystempfad verwendet,
  klassisches Zip-Slip ist dadurch strukturell nicht anwendbar.
- **Nur explizit angeforderte Entries werden überhaupt entpackt.**
  `docx_extract_text` entpackt ausschließlich `word/document.xml`,
  `xlsx_inspect` ausschließlich `xl/workbook.xml`, `xl/sharedStrings.xml`
  und die eine angefragte `xl/worksheets/sheetN.xml` — jeder andere Eintrag
  im Archiv wird aus der Central Directory gelesen, aber nie inflatiert.
- **Harte Größenlimits pro Entry und kumulativ** (`maxEntryInflatedBytes`
  20 MiB, `maxTotalInflatedBytes` 40 MiB) über Node's eigenes
  `zlib.inflateRawSync(..., { maxOutputLength })` — bricht **während** des
  Inflate ab, bevor ein übergroßer Buffer je vollständig im Speicher
  existiert. Live verifiziert: eine 25-MiB-hochkomprimierbare Nutzlast
  (komprimiert auf wenige KB) wird sauber als Job-Fehler abgelehnt, nie
  materialisiert.
- **Harte Obergrenze für die Anzahl Central-Directory-Einträge** (5000) —
  Schutz gegen einen Entry-Count-Bomb unabhängig von jeder Einzelgröße.
  Live verifiziert: ein Archiv mit 6000 leeren Einträgen scheitert vor jedem
  Inflate-Versuch.
- **`sharedStrings`-Bomb** (sehr viele deklarierte Shared Strings in
  `xl/sharedStrings.xml`): `parseSharedStrings()` (`src/lib/officeXml.ts`)
  bricht das Einlesen nach 20 000 Einträgen ab und meldet
  `shared_strings_truncated: true`, statt ein unbegrenztes Array aufzubauen.
  Live verifiziert mit 50 000 deklarierten Einträgen.
- **Zeilen-/Zellen-Limits bei `xlsx_inspect`**: maximal 5000 Zeilen gescannt,
  maximal 20 Beispielzeilen materialisiert, jede Zelle auf 500 Zeichen
  gekappt.
- **Kein XXE-Risiko**: `src/lib/officeXml.ts` ist bewusst **kein** allgemeiner
  XML-Parser, sondern ein enges Tag-/Regex-Scanning für exakt die bekannten
  OOXML-Tags (`<w:t>`, `<sheet>`, `<si>`, `<row>`/`<c>`). `<!DOCTYPE>`- oder
  Entity-Deklarationen werden nie interpretiert; die einzigen aufgelösten
  Entities sind die fünf vordefinierten XML-Entities
  (`&amp; &lt; &gt; &quot; &apos;`) plus numerische Zeichenreferenzen — es
  gibt keinen Codepfad, der beim Parsen eine lokale Datei liest oder eine
  Netzwerkanfrage stellt.
- **Fail-closed**: jeder Parse-/Inflate-Fehler (korruptes ZIP, fehlender
  Teil, Größenüberschreitung) wird als klarer Processor-Fehler
  weitergereicht, nie stillschweigend zu einem Teilergebnis degradiert.

Ein künftiger allgemeiner Entpack-Processor (echte `.zip`/`.tar`-Uploads)
müsste diese Begrenzung für generische Archive weiterhin separat und mit
eigenen Größen-/Tiefenlimits neu einführen (siehe [HANDOFF.md](HANDOFF.md)) —
die obige Lösung ist bewusst eng auf die beiden konkreten OOXML-Formate
zugeschnitten, kein allgemeiner Unzip-Mechanismus.

## Rate-Limiting

Die MCP-Spec (2026-07-28, "Security Considerations") verlangt: "Servers MUST
... Rate limit tool invocations." Umgesetzt in `src/lib/rateLimit.ts`,
pro Tool-Name (nicht pro Client — das Protokoll ist stateless, es gibt keine
verlässliche Caller-Identität, auf die man stattdessen limitieren könnte).
Drei Gewichtsklassen mit unterschiedlichem Budget pro Minute (alle per
Env-Var konfigurierbar): `read` (120), `write` (30), `critical` (15).
Überschreitung wirft `RateLimitExceededError`, die jeder Tool-Handler als
normalen Tool-Execution-Error (`isError: true`) zurückgibt — kein
Prozessabsturz, vom Modell selbst korrigierbar (abwarten, erneut versuchen).

## Explizite Bestätigung vor destruktiven Operationen

`rheinagent_file_delete_apply` ist als `destructiveHint: true` annotiert und
verlangt zusätzlich eine echte Bestätigung über den Multi-Round-Trip-
Mechanismus der Spec (`InputRequiredResult` → `elicitation/create` →
`inputResponses`), bevor die Datei tatsächlich gelöscht wird. Ohne
akzeptierte `confirm: true`-Antwort bleibt die Datei unverändert liegen.
Das ist eine echte Protokoll-Ebene-Bestätigung, keine bloße
Client-UI-Konvention.

## Vollständigkeit der Löschung (Cascade Delete)

`rheinagent_file_delete_apply` entfernt seit 2026-09-11 nicht nur die Datei
und ihren `FileRecord`, sondern auch jeden `JobRecord` und jedes
gespeicherte Job-Ergebnis, das sich auf diese Datei bezieht
(`cascadeDeleteJobsForFile()` in `src/lib/store.ts`). Vorher blieben
Processor-Ergebnisse nach "Löschung" der Quelldatei unbegrenzt abrufbar —
bei `text_uppercase` etwa ist das Ergebnis der komplette transformierte
Dateiinhalt, also faktisch eine zweite, ungelöschte Kopie. "Löschen"
bedeutet jetzt: Datei-Bytes, Metadaten, alle abgeleiteten Jobs und alle
abgeleiteten Ergebnisse sind weg.

## Keine verwaisten Upload-Bytes (Staging-Reaper)

Ein PUT auf die Data Plane ohne anschließendes `upload_finalize` (oder ganz
ohne PUT nach `upload_prepare`) hinterließ vor 2026-09-11 dauerhaft Bytes
unter `data/staging/` — die 15-Minuten-TTL löschte nur den JSON-Metadaten-
Eintrag beim nächsten Zugriff, nie die tatsächliche Datei, und ohne
erneuten Zugriff geschah auch das nie. `sweepOrphanedStaging()` (Control
Plane, einmal beim Start und danach alle 15 Minuten) entfernt jede
gestagte Datei ohne noch gültigen Pending-Upload-Eintrag und räumt dabei
zusätzlich abgelaufene Metadaten-Einträge proaktiv auf, statt auf einen
zufälligen künftigen Zugriff zu warten.

## Keine beliebigen Executor-Tools

Es gibt kein MCP-Tool, das beliebigen Code, Shell-Befehle oder Dateisystem-
Operationen jenseits der in dieser Liste beschriebenen ausführt.
`rheinagent_file_process_apply` kann ausschließlich einen der in
`src/lib/processors.ts` fest registrierten Processor-IDs aufrufen — der
`processor_id`-Parameter wählt aus einer Allowlist, führt keinen beliebigen
Code aus. Ein `process_prepare` mit einem `processor_id`/`mime_category`-
Mismatch (z. B. `text_stats` gegen eine PDF) wird seit 2026-09-11 schon vor
dem Anlegen des Jobs abgelehnt (`processorSupportsMimeCategory()`), nicht
erst nach einem realen, fehlgeschlagenen `process_apply`.

## Abhängigkeits-/Supply-Chain-Entscheidung: `pdfjs-dist`

Die einzige nicht-triviale Laufzeit-Abhängigkeit dieses Produkts jenseits
von `express`/`zod`/dem MCP-SDK ist `pdfjs-dist` (Mozillas PDF.js-Kern) für
`pdf_metadata`/`pdf_extract_text`. Bewusst **nicht** das populärere
`pdf-parse` verwendet, das `@napi-rs/canvas` — ein natives Rust-Addon —
als Hard-Dependency zieht, unnötig für reine Textextraktion und auf einem
arm64-On-Prem-Host (`berry`) sowohl größere Angriffsfläche (kompilierter
Code statt reinem JS) als auch ein Cross-Compile-/Prebuilt-Binary-Risiko.
`pdfjs-dist` selbst hat **null** eigene Laufzeit-Abhängigkeiten. Bild-
Metadaten (`image_metadata`) brauchen dagegen gar keine Bibliothek — PNG-/
JPEG-Dimensionen werden per Hand aus den jeweiligen Headern gelesen
(`src/lib/processors.ts`), genau wie die Magic-Byte-Erkennung in
`security.ts`.

## Audit-Schreib-Sicherheit

Kritische Mutationen (`upload_finalize`, `process_apply`, `delete_apply`)
laufen über `auditCriticalWrite()` (siehe [AUDIT.md](AUDIT.md)). Im
`hub`-Modus wird die eigentliche Mutation **erst nach** einer durable
`intent_durable`-Bestätigung ausgeführt (fail-closed). Im `off`-Modus (Default)
gibt es keine Audit-Abhängigkeit und keine Verzögerung.

## Bekannte Grenzen dieser Version

- Keine Mandanten-/Nutzertrennung — ein Betrieb pro Control-Plane-Instanz.
- Metadaten liegen seit 2026-09-11 in SQLite (WAL-Modus,
  `src/lib/sqliteIndex.ts`) statt in whole-file-JSON — echte
  Read-Committed-Transaktionen pro Zeile statt "last write wins" beim
  gleichzeitigen Schreiben zweier Prozesse auf denselben Datensatz, siehe
  [STATE-MIGRATION.md](STATE-MIGRATION.md). Weiterhin **kein** verteiltes
  Locking über mehrere Hosts hinweg — für Einzelbetrieb (Control-/Data-Plane
  auf demselben Host) gedacht, nicht für Hochlast-Mehrinstanz-Szenarien.
- `rheinagent_file_get` liefert Inhalt nur für kleine Textdateien inline;
  größere/binäre Dateien laufen über `rheinagent_file_download_prepare` +
  den Data-Plane-`GET /download/:downloadToken`-Endpunkt.
- Kein TLS/Auth auf Control- oder Data-Plane-HTTP-Ebene in dieser Version —
  für den Produktionsbetrieb muss das über die RheinAgent-Manager-verwaltete
  Service-Identität/Reverse-Proxy-Schicht kommen, nicht aus eigenem Code
  (siehe [LICENSE-FLOW.md](LICENSE-FLOW.md) zu Ownership-Grenzen). Als
  Mitigation dafür binden beide Prozesse standardmäßig nur an `127.0.0.1`
  (`RHEINAGENT_FILE_UPLOAD_BIND_HOST`) statt an alle Interfaces — vor
  2026-09-11 war das nicht der Fall, siehe [BUILDLOG.md](../BUILDLOG.md).

## Verbotene öffentliche Flächen

- Kein Tool, das beliebige Shell-Kommandos, Dateisystempfade außerhalb von
  `data/` oder beliebigen Code entgegennimmt.
- Kein Tool, das Lizenzcodes, Manager- oder Update-Feed-Credentials
  entgegennimmt, speichert oder zurückgibt (siehe [LICENSE-FLOW.md](LICENSE-FLOW.md)).
- Kein Tool, das rohe Audit-Hub-Credentials oder Customer-Root-Material
  zurückgibt (siehe [AUDIT.md](AUDIT.md)).
