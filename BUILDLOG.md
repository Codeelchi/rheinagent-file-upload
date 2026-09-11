# Buildlog

Chronologisches Protokoll der Änderungen an diesem MCP-Server. Neueste Einträge oben.

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
