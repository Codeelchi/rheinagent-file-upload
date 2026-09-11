# Buildlog

Chronologisches Protokoll der Änderungen an diesem MCP-Server. Neueste Einträge oben.

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
