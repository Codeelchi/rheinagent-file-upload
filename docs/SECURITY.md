# Security

## Trust-Grenzen

- MCP-Clients sind nicht vertrauenswürdig bezüglich Dateiinhalt, Dateiname
  und deklarierter Größe — jede Angabe wird serverseitig erneut geprüft.
- Die Control Plane vertraut der Data Plane nur insoweit, dass sie Bytes
  unverändert unter dem vorgesehenen `upload_id`-Pfad ablegt; die eigentliche
  Validierung (Magic-Bytes, Größe, Extension-Konsistenz) passiert
  ausschließlich in der Control Plane (`upload_finalize`), nie in der Data
  Plane selbst.
- Der zentrale Audit Hub (falls `RA_AUDIT_MODE=hub`) ist ein separater
  Trust-Boundary-Partner mit eigenem Service-Credential — siehe [AUDIT.md](AUDIT.md).

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
   .pdf .png .jpg .jpeg`
4. **Magic-Byte-Sniffing** (`sniffMimeCategory`) der tatsächlichen Bytes,
   unabhängig von der deklarierten Extension
5. **Konsistenzprüfung**: deklarierte Kategorie muss der gesniffelten
   Kategorie entsprechen — ein als `.txt` deklariertes PNG wird abgelehnt
   (verifizierter Testfall, siehe [BUILDLOG.md](../BUILDLOG.md))
6. **SHA-256-Hash** wird berechnet und in den Metadaten gespeichert (Grundlage
   für künftige Integritäts-/Dedup-Prüfungen, aktuell nicht gegen einen
   externen Referenzwert verglichen)

## Archive-Bomb-Grenzen

Archivformate (`.zip .tar .gz .7z .rar`, auch via Magic-Byte-Erkennung `PK\x03\x04`)
werden **grundsätzlich abgelehnt**, nicht größenbeschränkt entpackt. Diese
Version enthält keinen Entpack-Processor — das Archive-Bomb-Risiko ist damit
strukturell ausgeschlossen, nicht durch eine Kompressionsverhältnis-Heuristik
gemindert. Ein künftiger Entpack-Processor müsste diese Begrenzung explizit
und mit echten Größen-/Tiefenlimits neu einführen (siehe [HANDOFF.md](HANDOFF.md)).

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

## Keine beliebigen Executor-Tools

Es gibt kein MCP-Tool, das beliebigen Code, Shell-Befehle oder Dateisystem-
Operationen jenseits der in dieser Liste beschriebenen ausführt.
`rheinagent_file_process_apply` kann ausschließlich einen der in
`src/lib/processors.ts` fest registrierten Processor-IDs aufrufen — der
`processor_id`-Parameter wählt aus einer Allowlist, führt keinen beliebigen
Code aus.

## Audit-Schreib-Sicherheit

Kritische Mutationen (`upload_finalize`, `process_apply`, `delete_apply`)
laufen über `auditCriticalWrite()` (siehe [AUDIT.md](AUDIT.md)). Im
`hub`-Modus wird die eigentliche Mutation **erst nach** einer durable
`intent_durable`-Bestätigung ausgeführt (fail-closed). Im `off`-Modus (Default)
gibt es keine Audit-Abhängigkeit und keine Verzögerung.

## Bekannte Grenzen dieser Version

- Keine Mandanten-/Nutzertrennung — ein Betrieb pro Control-Plane-Instanz.
- Metadaten-Schreibzugriffe über zwei Prozesse (Control-/Data-Plane) sind
  "last write wins" bei echter Gleichzeitigkeit auf denselben Datensatz
  (siehe `src/lib/jsonIndex.ts`) — für Einzelbetrieb akzeptiert, nicht für
  Hochlast-Mehrinstanz-Szenarien gedacht.
- `rheinagent_file_get` liefert Inhalt nur für kleine Textdateien inline;
  es gibt noch keinen Data-Plane-Download-Endpunkt für größere/binäre
  Dateien (siehe [HANDOFF.md](HANDOFF.md)).
- Kein TLS/Auth auf Control- oder Data-Plane-HTTP-Ebene in dieser Version —
  für den Produktionsbetrieb muss das über die RheinAgent-Manager-verwaltete
  Service-Identität/Reverse-Proxy-Schicht kommen, nicht aus eigenem Code
  (siehe [LICENSE-FLOW.md](LICENSE-FLOW.md) zu Ownership-Grenzen).

## Verbotene öffentliche Flächen

- Kein Tool, das beliebige Shell-Kommandos, Dateisystempfade außerhalb von
  `data/` oder beliebigen Code entgegennimmt.
- Kein Tool, das Lizenzcodes, Manager- oder Update-Feed-Credentials
  entgegennimmt, speichert oder zurückgibt (siehe [LICENSE-FLOW.md](LICENSE-FLOW.md)).
- Kein Tool, das rohe Audit-Hub-Credentials oder Customer-Root-Material
  zurückgibt (siehe [AUDIT.md](AUDIT.md)).
