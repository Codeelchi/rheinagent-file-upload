# RheinAgent File Upload MCP

On-prem/lokal betreibbarer MCP-Server für sicheren File Upload, Dateiverwaltung
und kontrollierte serverseitige Dateiverarbeitung.

- **Product slug:** `rheinagent-file-upload`
- **MCP-Protokoll:** `2026-07-28`
- **Package-v2-Profil:** `rheinagent-file-upload@1`
- **Audit-Profil:** `rheinagent-file-upload@1`
- **Health-Profil:** `rheinagent-file-upload-v1`

## Architekturprinzipien

- Kein beliebiges Shell-/Filesystem-/Executor-Tool — nur fest registrierte,
  serverseitige Processor (`src/lib/processors.ts`): `text_stats`/
  `text_uppercase` (Text), `image_metadata` (PNG/JPEG, ohne Bildbibliothek
  — Dimensionen selbst geparst), `pdf_metadata`/`pdf_extract_text` (PDF,
  via `pdfjs-dist`, bewusst ohne dessen native `canvas`-Abhängigkeit)
- MCP-Tools arbeiten ausschließlich mit opaken `file_id`/`job_id`/`upload_id`
  (nie mit Dateinamen oder Pfaden als Identifikator)
- Große Binärdaten laufen nie als Base64 durch MCP-JSON — Upload/Finalize
  sind getrennt vom eigentlichen Byte-Transport (**Data Plane**, `dataplane.ts`)
- Staging vor finaler Übernahme, Validierung von Größe/Magic-Bytes/Extension/Hash
- Kritische Mutationen folgen Read/Prepare/Apply/Verify; siehe [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Lizenzierung und Audit sind bewusst **nicht** selbst implementiert, sondern
  binden an die zentralen RheinAgent-Plattformdienste an — siehe
  [docs/LICENSE-FLOW.md](docs/LICENSE-FLOW.md) und [docs/AUDIT.md](docs/AUDIT.md)
- Jedes Tool-Ein-/Ausgabefeld ist `snake_case`; `file_id`/`job_id`/
  `upload_id`/`delete_token` werden bereits im `inputSchema` per Präfix-
  Regex validiert, nicht erst tief in der Implementierung
- Der Server erklärt sein eigenes Workflow-Muster dem anfragenden LLM über
  das `instructions`-Feld der `initialize`-Antwort **und** redundant über
  `rheinagent_file_capabilities_get`s `usage`-Feld — siehe
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Schnellstart (lokal/Entwicklung)

```bash
npm install
npm run serve             # Control Plane (MCP), Port 3901
npm run serve:dataplane   # Data Plane (Upload-Bytes), Port 3902
```

Details zu Konfiguration, Audit-Opt-in und Betrieb: [docs/INSTALLATION.md](docs/INSTALLATION.md).

## Öffentliche MCP-Tools

| Tool | Zweck |
|---|---|
| `rheinagent_file_capabilities_get` | Protokollversion, Profile, Limits, Processor-Liste |
| `rheinagent_file_health_get` | Health/Doctor: Plane-Erreichbarkeit, Verzeichnis-Schreibbarkeit, Audit-Status |
| `rheinagent_file_upload_prepare` | Upload ankündigen, opake `upload_id` + Data-Plane-URL erhalten |
| `rheinagent_file_upload_finalize` | Staged Bytes validieren und final übernehmen |
| `rheinagent_file_list` | Akzeptierte Dateien auflisten (Metadaten), filterbar nach `mime_category`/`filename_contains` |
| `rheinagent_file_get` | Metadaten (und kleine Text-Inhalte) abrufen |
| `rheinagent_file_rename` | Anzeigenamen ändern (nie Bytes/`mime_category`) |
| `rheinagent_file_download_prepare` | `download_token` + Data-Plane-URL für große/binäre Dateien erhalten |
| `rheinagent_file_process_prepare` | Verarbeitungsjob für einen registrierten Processor anlegen |
| `rheinagent_file_process_apply` | Job ausführen, Ergebnis atomar speichern |
| `rheinagent_file_job_get` | Job-Status abrufen |
| `rheinagent_file_job_list` | Jobs auflisten, filterbar nach `file_id`/`state`/`processor_id` |
| `rheinagent_file_result_get` | Job-Ergebnis abrufen |
| `rheinagent_file_delete_prepare` | Löschung vorbereiten (`delete_token`) |
| `rheinagent_file_delete_apply` | Löschung mit `delete_token` final ausführen |

Vollständige Nutzlasten/Felder: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Dokumentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Control-/Data-Plane-Trennung, Tool-Verträge, Staging/Quarantine
- [docs/SECURITY.md](docs/SECURITY.md) — Validierung, Path-Traversal/Symlink/Archive-Bomb-Schutz, Threat-Model
- [docs/AUDIT.md](docs/AUDIT.md) — Anbindung an den zentralen RheinAgent Audit Hub
- [docs/LICENSE-FLOW.md](docs/LICENSE-FLOW.md) — Lizenz-/Aktivierungsfluss über Manager/License Service
- [docs/INSTALLATION.md](docs/INSTALLATION.md) — Betrieb, Umgebungsvariablen, Audit-Opt-in
- [docs/VERSIONING.md](docs/VERSIONING.md) — Versionsquelle, Release-Kanäle, Package-v2
- [docs/HANDOFF.md](docs/HANDOFF.md) — Offene Integrationsarbeit in zentralen RheinAgent-Repos
- [BUILDLOG.md](BUILDLOG.md) — Chronologisches Änderungsprotokoll

## Nicht Teil dieses Repos

Dieses Repo ändert **keine** zentralen RheinAgent-Repos (Manager, License
Service, Update Feed, Audit). Erforderliche Integrationsschritte dort sind
in [docs/HANDOFF.md](docs/HANDOFF.md) dokumentiert, nicht umgesetzt.
