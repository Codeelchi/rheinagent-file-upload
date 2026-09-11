# Architektur

## Source of truth

GitHub-Repo `Codeelchi/rheinagent-file-upload`, Branch `main`. Entwicklung
ausschließlich hier; Distribution läuft über die zentrale Pipeline
(siehe [VERSIONING.md](VERSIONING.md)), nicht über dieses Repo direkt.

## Runtime-Layer

```text
┌─────────────────────────┐       ┌──────────────────────────┐
│  Control Plane           │       │  Data Plane               │
│  server.ts (Port 3901)   │       │  dataplane.ts (Port 3902) │
│  MCP JSON-RPC (/mcp)     │       │  rohe Bytes (HTTP PUT)    │
│  11 öffentliche Tools    │       │  keine MCP-Tools, kein     │
│  Business-/Sicherheits-  │       │  Audit, keine Business-    │
│  logik, Audit-Aufrufe    │       │  logik — nur Staging-Write │
└────────────┬─────────────┘       └────────────┬──────────────┘
             │                                   │
             └──────────────┬────────────────────┘
                             ▼
                    data/ (gemeinsames Dateisystem)
                    staging/  files/  results/  meta/*.json
```

Beide Prozesse sind **getrennt**, weil große Binärdaten nie durch MCP-JSON
laufen sollen: der Control-Plane-Prozess kennt nur `upload_id`/`file_id`/
`job_id`, nie rohe Bytes im Request/Response-Pfad (außer dem Sonderfall
kleiner Text-Inhalte in `rheinagent_file_get`, siehe unten). Beide Prozesse
teilen sich ausschließlich das Dateisystem unter `data/`, nicht den
Prozessspeicher — jede Metadaten-Tabelle liest/schreibt bei jedem Zugriff
frisch von Platte (`src/lib/jsonIndex.ts`), damit keiner der beiden Prozesse
mit einem veralteten In-Memory-Stand des anderen arbeitet.

## Identität/Autorisierung

Diese erste Version hat **keine eigene Nutzer-/Mandantentrennung** — alle
MCP-Clients, die den Control-Plane-Endpunkt erreichen, teilen sich denselben
Datei-/Job-Namespace. Das ist eine bewusste v1-Einschränkung für
Einzelbetrieb, siehe [SECURITY.md](SECURITY.md) und [HANDOFF.md](HANDOFF.md).

## Read / Prepare / Apply / Verify

Jede zustandsverändernde Operation folgt demselben Muster statt einer
einzelnen "mach es einfach"-Aktion:

| Bereich | Prepare | Apply/Verify |
|---|---|---|
| Upload | `rheinagent_file_upload_prepare` legt einen befristeten Staging-Platz an (15 min TTL) | `rheinagent_file_upload_finalize` validiert (Größe/Magic-Bytes/Extension/Hash) und verschiebt atomar nach `files/` |
| Verarbeitung | `rheinagent_file_process_prepare` legt einen Job an, führt **nichts aus** | `rheinagent_file_process_apply` führt den registrierten Processor aus und schreibt das Ergebnis atomar (temp-write + rename) |
| Löschung | `rheinagent_file_delete_prepare` markiert `pendingDelete`, Datei bleibt vorerst liegen | `rheinagent_file_delete_apply` entfernt die Datei endgültig anhand des `delete_token` |

Ein Prepare-Schritt ist jederzeit folgenlos verwerfbar (TTL-Ablauf bzw.
schlicht nicht-Apply). Erst der Apply-Schritt ist die tatsächliche,
auditierte kritische Mutation (siehe [AUDIT.md](AUDIT.md)).

## Staging / Quarantine

Hochgeladene Bytes landen zunächst unter `data/staging/<upload_id>` — einem
rein opaken, vom Client nicht wählbaren Pfad. Erst `upload_finalize` liest
diese Datei, prüft sie server-seitig (siehe [SECURITY.md](SECURITY.md)) und
verschiebt sie per `fs.rename` (atomar auf demselben Volume) nach
`data/files/<file_id>`. Schlägt die Prüfung fehl, wird die Staging-Datei
gelöscht und die Quarantine verlassen nie — es gibt keinen Pfad, auf dem
ungeprüfte Bytes in `files/` ankommen.

## Processor-Registry

`src/lib/processors.ts` enthält eine feste `Map<string, Processor>`. Ein
Processor ist eine zur Build-Zeit registrierte TypeScript-Funktion, die eine
lokale Datei liest und ein JSON-Ergebnis zurückgibt — kein Shell-Aufruf, kein
`eval`, keine vom Client mitgelieferte Logik. Neue Fähigkeiten bedeuten einen
neuen Registry-Eintrag plus Release, nie eine Laufzeit-Erweiterung durch ein
MCP-Tool. Aktuell registriert: `text_stats`, `text_uppercase` (beide nur für
Text-Dokumente, siehe [SECURITY.md](SECURITY.md) zur MIME-Kategorisierung).

## Öffentliche Tool-Verträge

| Tool | Input | Output (`structuredContent.action`) |
|---|---|---|
| `rheinagent_file_capabilities_get` | — | Capability-Objekt |
| `rheinagent_file_upload_prepare` | `filename`, `declared_size_bytes` | `{upload_id, upload_url, expires_at}` |
| `rheinagent_file_upload_finalize` | `upload_id` | `action: "uploaded"`, `FileRecord` |
| `rheinagent_file_list` | — | `action: "list"`, `FileRecord[]` |
| `rheinagent_file_get` | `file_id` | `action: "view"`, `FileRecord` (+`content` bei kleinen Textdateien) |
| `rheinagent_file_process_prepare` | `file_id`, `processor_id` | `action: "job_prepared"`, `JobRecord` |
| `rheinagent_file_process_apply` | `job_id` | `action: "job_completed"`, Processor-Ergebnis |
| `rheinagent_file_job_get` | `job_id` | `action: "job_status"`, `JobRecord` |
| `rheinagent_file_result_get` | `job_id` | `action: "job_result"`, Processor-Ergebnis |
| `rheinagent_file_delete_prepare` | `file_id` | `action: "delete_prepared"`, `{delete_token, file_id}` |
| `rheinagent_file_delete_apply` | `delete_token` | `action: "list"`, verbleibende `FileRecord[]` |

## Audit-/Release-Grenze

Dieses Repo enthält keine eigene Audit-Speicherung, keinen eigenen
Lizenz-Client und keine Signier-/Verteil-Logik — siehe [AUDIT.md](AUDIT.md),
[LICENSE-FLOW.md](LICENSE-FLOW.md), [VERSIONING.md](VERSIONING.md).

## MCP-App-UI (optional)

Es existiert aktuell **keine** angebundene MCP-App-UI für diese Tool-Menge
(ein früherer Prototyp mit abweichenden Tool-Namen wurde entfernt, siehe
[BUILDLOG.md](../BUILDLOG.md)). Alle Business-Funktionen sind vollständig
ohne UI nutzbar — eine UI-Wiederanbindung ist ein späteres, optionales
Fast-Follow, siehe [HANDOFF.md](HANDOFF.md).
