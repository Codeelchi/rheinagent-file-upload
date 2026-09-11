# Audit

## Vertrag

Dieses Produkt betreibt **keine eigene** Audit-Datenbank, Hash-Chain,
Root-Identität oder Checkpoint-Engine. Jegliche Audit-Funktionalität läuft
ausschließlich über den zentralen RheinAgent Audit Hub
(`Codeelchi/rheinagent-audit`), per thin client in `src/lib/audit.ts` — in
Übereinstimmung mit ADR-013 ("MCP Opt-In Integration Contract"): ein Produkt
darf nur ein Profil-Manifest + dünnen Client-Adapter enthalten, keine eigene
Speicherung, keinen eigenen Ed25519-Checkpoint-Signierer, keinen eigenen
Viewer.

## Zwei Modi, `RA_AUDIT_MODE`

| Modus | Verhalten |
|---|---|
| `off` (**Default**) | Keine Hub-Abhängigkeit, keine Registrierung, kein Credential, kein Netzwerkaufruf. Normale Tool-Funktion unverändert. |
| `hub` | Voller Write-Ahead-Vertrag für kritische Mutationen (siehe unten), fail-closed. |

## Credential-Trennung

```text
RA_AUDIT_MODE=off|hub
RA_AUDIT_ENDPOINT=http://127.0.0.1:8766
RA_AUDIT_SERVICE_ID=<opaque service id>
RA_AUDIT_CREDENTIAL_PATH=<Pfad zu einer geschützten Credential-Datei>
RA_AUDIT_PROTOCOL_VERSION=rheinagent-audit/1
```

Das Service-Credential ist ein eigenständiges, rotierbares Token — **niemals**
der Manager-Credential oder ein Lizenzcode (siehe [LICENSE-FLOW.md](LICENSE-FLOW.md)).
Es wird ausschließlich aus `RA_AUDIT_CREDENTIAL_PATH` gelesen, nie inline aus
einer Umgebungsvariable, nie geloggt. Ein kompromittiertes Credential dieses
Produkts legt keine andere Service-Chain offen (Hub-seitige Eigenschaft,
nicht etwas, das dieses Produkt selbst durchsetzt).

> **Hinweis zur Namensgebung:** Andere RheinAgent-Produkte verwenden
> uneinheitliche Variablennamen (`rheinagent-knowledge-mcp` nutzt z. B.
> `RA_AUDIT_HUB_URL` statt `RA_AUDIT_ENDPOINT`). Dieses Produkt folgt der
> Namensgebung aus `rheinagent-backoffice` (`RA_AUDIT_ENDPOINT` +
> `RA_AUDIT_SERVICE_ID` + `RA_AUDIT_CREDENTIAL_PATH`) als jüngerem,
> ausführlicher dokumentiertem Integrationsvertrag. Diese Inkonsistenz
> zwischen Produkten ist plattformweit ungelöst — siehe [HANDOFF.md](HANDOFF.md).

## Profil `rheinagent-file-upload@1`

Audit-Profil und Package-v2-Profil tragen denselben Bezeichner
(`rheinagent-file-upload@1`), sind aber unterschiedliche Artefakte: das
Package-v2-Profil beschreibt die Manager-Aktivierung (siehe
[VERSIONING.md](VERSIONING.md)), das Audit-Profil die `allowed_metadata_keys`
pro Aktion (Tabelle unten). Beide müssen Hub-/Manager-seitig unabhängig
registriert werden (siehe [HANDOFF.md](HANDOFF.md)).

## Lese-Semantik (Invocation, fail-open)

`rheinagent_file_capabilities_get`, `_list`, `_get`, `_job_get`,
`_result_get` sowie die Prepare-Schritte (`upload_prepare`,
`process_prepare`, `delete_prepare`) erzeugen höchstens ein
Invocation-Event über `auditInvocation()`. Im `hub`-Modus degradiert ein
Hub-Fehler hier stillschweigend (Policy `RA_AUDIT_POLICY=normal`) — die
Tool-Funktion wird dadurch nie blockiert.

## Kritische Schreib-Semantik (Write-Ahead, fail-closed)

`upload_finalize`, `process_apply` und `delete_apply` laufen über
`auditCriticalWrite()`:

```text
Client  -> POST /v1/events/begin  (INTENT)
Hub     -> durable append + ACK "intent_durable"
Client  -> Business-Mutation (erst jetzt!)
Client  -> POST /v1/events/phase APPLY
Client  -> POST /v1/events/phase VERIFY
Client  -> POST /v1/events/phase RESULT
```

Ohne `intent_durable`-ACK wird die Mutation **nicht ausgeführt** — das ist
im Code erzwungen (`auditCriticalWrite` wirft, bevor `mutation()` je
aufgerufen wird). Ein `RESULT=success` ohne vorherige durable APPLY wird
Hub-seitig abgelehnt (außerhalb der Kontrolle dieses Produkts).

**Wichtiger Hinweis zum Implementierungsstand:** Dieser Write-Ahead-Pfad ist
gegen die dokumentierte Spezifikation (`rheinagent-audit` ARCHITECTURE.md §6,
ADR-002/004/008/013) implementiert, aber **noch nicht gegen eine laufende
Hub-Instanz verifiziert**. Status: implementiert, nicht live getestet — siehe
[HANDOFF.md](HANDOFF.md).

### Abweichung von der ursprünglichen Vorgabe (dokumentiert, nicht stillschweigend)

Die Produktvorgabe gruppiert `delete_prepare` und `delete_apply` beide unter
`DELETE/high, write_ahead=true`. Diese Implementierung behandelt nur
`delete_apply` als kritische Schreib-Mutation (write-ahead) und
`delete_prepare` als reversibles PREPARE (nur Invocation) — konsistent mit
dem Read/Prepare/Apply/Verify-Prinzip: das Setzen von `pendingDelete=true`
ist folgenlos rückgängig machbar, die tatsächliche Löschung nicht. Analog für
`process_prepare` (Invocation) vs. `process_apply` (Write-Ahead).

## Audit-Privacy-Allowlist

Pro Tool/Aktion ist eine feste Menge erlaubter Metadaten-Schlüssel
festgelegt — niemals Dateiname, Pfad, Inhalt oder extrahierter Text:

| Tool | Aktion | Erlaubte Keys | Verboten (nie im Journal) |
|---|---|---|---|
| `rheinagent_file_upload_prepare` | `file.upload.prepare` (Invocation) | `mime_category`, `declared_size_bytes` | Dateiname, Pfad |
| `rheinagent_file_upload_finalize` | `file.upload.finalize` (WRITE, write-ahead) | `mime_category`, `final_size_bytes` | Dateiname, Inhalt, Hash als Klartext |
| `rheinagent_file_list` | `rheinagent_file_list` (Invocation) | `result_count` | Dateinamen der Liste |
| `rheinagent_file_get` | `rheinagent_file_get` (Invocation) | — | Inhalt |
| `rheinagent_file_process_prepare` | `rheinagent_file_process_prepare` (Invocation) | `processor_id` | — |
| `rheinagent_file_process_apply` | `file.process.apply` (WRITE, write-ahead) | `processor_id` | Verarbeitungsergebnis/-inhalt |
| `rheinagent_file_delete_apply` | `file.delete.apply` (DELETE, write-ahead) | — | Dateiname |

Die in `src/lib/audit.ts` hinterlegte `SENSITIVE_KEY_PATTERNS`-Liste blockt
zusätzlich verdächtige Schlüsselnamen (`content`, `path`, `filename`, …) als
Verteidigung in der Tiefe, selbst falls eine Allowlist versehentlich einen
solchen Key enthielte. `content_logged` ist im Vertrag fest `false` — nicht
konfigurierbar, kein Override.

## Installer-/Profil-Migration

Entfällt für v1 (kein Vorgänger-Audit-Profil). Ein künftiger
Profil-Versionswechsel (`rheinagent-file-upload@2`) dürfte bestehende
Credentials nicht stillschweigend auf das neue Profil ummünzen (gleiche
Regel wie bei anderen RheinAgent-Produkten, siehe Briefing-Kontradiktionen
in [HANDOFF.md](HANDOFF.md)).
