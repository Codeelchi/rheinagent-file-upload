# Audit

## Vertrag und Source of Truth

Dieses Produkt betreibt **keine eigene** Audit-Datenbank, Hash-Chain,
Root-Identitaet, Signatur- oder Checkpoint-Engine. Es integriert ausschliesslich
den zentralen RheinAgent Audit Hub (`Codeelchi/rheinagent-audit`) ueber:

1. das produkt-eigene Profil `rheinagent-file-upload@1`,
2. den duennen TypeScript-Adapter `src/lib/audit.ts`.

Der bei der aktuellen Abnahme verifizierte Audit-Stand ist
`eb6765ed2c5e59ae9ae66021211e02fed66fae6a` mit installierter
Hub-Version `rheinagent-audit-core 0.2.0rc1`. Vor einer spaeteren Aenderung des
Adapters den aktuellen Audit-main erneut pruefen.

## Betriebsmodi

`RA_AUDIT_MODE` kennt zwei Werte:

| Modus | Verhalten |
|---|---|
| `off` (**Default**) | Keine Hub-Abhaengigkeit und keine Audit-Netzwerkaufrufe. |
| `hub` | Zentraler Hub ist fuer kritische Mutationen Teil des Sicherheitsvertrags. |

Konfiguration:

- `RA_AUDIT_MODE=off|hub`
- `RA_AUDIT_ENDPOINT`
- `RA_AUDIT_SERVICE_ID`
- `RA_AUDIT_CREDENTIAL_PATH`
- `RA_AUDIT_PROTOCOL_VERSION`
- `RA_AUDIT_ALLOW_PRIVATE_HTTP=false`

Loopback-HTTP ist erlaubt. Nicht-loopback HTTP wird standardmaessig abgelehnt;
nur fuer einen bewusst geschuetzten internen Transport darf
`RA_AUDIT_ALLOW_PRIVATE_HTTP=true` gesetzt werden. HTTPS ist ohne dieses
Opt-in zulaessig.

Das Service-Credential ist eigenstaendig und rotierbar. Es ist **kein**
Manager-Credential und **kein** Lizenzcode. Der Adapter liest es nur aus
`RA_AUDIT_CREDENTIAL_PATH`; Credential-Wert, Authorization-Header und
Dateiinhalte duerfen nie im Audit-Metadatenfeld landen.

## Profil `rheinagent-file-upload@1`

`AUDIT_PROFILE_ID` in `src/lib/audit.ts` ist die Runtime-Konstante. Das portable
Hub-Profil liegt unter `audit/rheinagent-file-upload-v1.json`. Der
Drift-Test `test/audit-profile.test.ts` erzwingt, dass:

- alle 18 registrierten MCP-Tools genau einmal im Profil vorkommen,
- Action, Classification, Risk, `sensitive`, `write_ahead` und
  Metadaten-Allowlist exakt mit `AUDIT_ACTIONS` uebereinstimmen,
- jede WRITE/DELETE/SECURITY/CONFIG/UPDATE-Aktion write-ahead ist.

Das Docker-Image kopiert das Profil nach `/app/audit` mit ein. Die eigentliche
produktive Hub-Registrierung samt Service-Credential bleibt ein separater
Deployment-/Cross-Repo-Schritt und ist nicht im Produkt-Image eingebrannt.

## Tool-/Action-Matrix

| Tool | Audit-Aktion | Klasse / Risiko | Write-ahead | Erlaubte Metadaten |
|---|---|---|---|---|
| `rheinagent_file_capabilities_get` | `file.capabilities.read` | READ / low | nein | - |
| `rheinagent_file_health_get` | `file.health.read` | READ / low | nein | `status` |
| `rheinagent_file_upload_prepare` | `file.upload.prepare` | PREPARE / low | nein | `mime_category`, `declared_size_bytes` |
| `rheinagent_file_upload_finalize` | `file.upload.finalize` | WRITE / high | **ja** | `mime_category`, `final_size_bytes`, `verification_result` |
| `rheinagent_file_list` | `file.list` | READ / low | nein | `result_count` |
| `rheinagent_file_get` | `file.read` | READ / medium, sensitive | nein | - |
| `rheinagent_file_rename` | `file.rename` | WRITE / medium | **ja** | `mime_category`, `verification_result` |
| `rheinagent_file_verify` | `file.verify` | READ / medium | nein | `matches` |
| `rheinagent_file_duplicate_check` | `file.duplicate.check` | READ / medium | nein | `duplicate_count` |
| `rheinagent_file_knowledge_handoff_prepare` | `file.knowledge.handoff.prepare` | PREPARE / medium, sensitive | nein | `has_content` |
| `rheinagent_file_download_prepare` | `file.download.prepare` | PREPARE / medium, sensitive | nein | - |
| `rheinagent_file_process_prepare` | `file.process.prepare` | PREPARE / low | nein | `processor_id` |
| `rheinagent_file_process_apply` | `file.process.apply` | WRITE / high | **ja** | `processor_id`, `verification_result` |
| `rheinagent_file_job_get` | `file.job.read` | READ / low | nein | - |
| `rheinagent_file_job_list` | `file.job.list` | READ / low | nein | `result_count` |
| `rheinagent_file_result_get` | `file.result.read` | READ / medium, sensitive | nein | - |
| `rheinagent_file_delete_prepare` | `file.delete.prepare` | PREPARE / medium | nein | - |
| `rheinagent_file_delete_apply` | `file.delete.apply` | DELETE / high | **ja** | `verification_result` |

`rheinagent_file_delete_prepare` setzt nur den reversiblen Pending-Delete-Zustand
und bleibt bewusst PREPARE. Die irreversible Loeschung passiert erst in
`rheinagent_file_delete_apply` und ist write-ahead. Dasselbe Prepare/Apply-Prinzip
gilt fuer Verarbeitung.

## READ/PREPARE: Invocation-Semantik

Nicht-kritische Aufrufe senden im Hub-Modus ein `POST /v1/events/invocation`
mit mindestens:

- semantischer `action`,
- `tool`,
- `result: "success"`,
- nur erlaubten `metadata`,
- eindeutiger `X-RA-Request-Id`.

Die normale Policy ist gezielt fail-open **nur bei echter Hub-Unverfuegbarkeit**
(Netzwerk/Timeout/5xx). Ein 4xx-Fehler wie falsches Credential, unbekanntes
Profil oder Contract-Verletzung wird nicht verschluckt, weil er eine
Konfigurations-/Deployment-Luecke darstellt.

## Kritische Mutationen: Write-Ahead und Reconciliation

`rheinagent_file_upload_finalize`, `rheinagent_file_rename`,
`rheinagent_file_process_apply` und `rheinagent_file_delete_apply` laufen ueber
`auditCriticalWrite()`:

1. `POST /v1/events/begin` muss `status: "intent_durable"` und eine
   `correlation_id` liefern.
2. Erst danach darf die Business-Mutation laufen.
3. Danach folgen `APPLY`, reale Business-Postcondition, `VERIFY` und `RESULT`.
4. Erst nach erfolgreichem `RESULT` gilt der Audit-Lifecycle als vollstaendig.

Die Phase-Requests verwenden den vom Hub gelieferten `correlation_id`; der
Client erfindet keine `request_id` im Body. Fuer Idempotenz/Replay-Schutz wird
pro HTTP-Aufruf ein eindeutiger `X-RA-Request-Id`-Header gesetzt.

Semantik bei Fehlern:

- **Vor durable INTENT:** Mutation wird nicht gestartet. Fail-closed.
- **Business-Mutation wirft:** best-effort `RESULT failure`; der eigentliche
  Business-Fehler bleibt sichtbar.
- **Hub faellt nach erfolgreicher Mutation aus:** `AuditIncompleteError`. Der
  Aufrufer darf nicht behaupten, die Business-Aktion sei nicht passiert, und
  darf nicht blind wiederholen. Hub-/Business-Zustand muss reconciled werden.
- **Reale Postcondition schlaegt fehl:** best-effort `RESULT failure` und
  `AuditBusinessVerificationError`; auch hier kein blinder Retry.

Besonders bei `rheinagent_file_process_apply` wird ein bereits erfolgreich
geschriebener Result-/Job-Zustand bei nachgelagertem Audit-Ausfall **nicht**
nachtraeglich als `failed` ummarkiert.

## Health/Doctor

`rheinagent_file_health_get` prueft im Hub-Modus getrennt:

- Audit-Konfiguration vollstaendig,
- unauthentifiziertes Hub-Liveness `GET /healthz`,
- authentifiziertes `GET /v1/service/health` fuer genau die konfigurierte
  Service-ID und Credential-Datei.

Fehlt eine dieser Voraussetzungen oder meldet der Service nicht `HEALTHY`,
meldet der Produkt-Healthcheck `degraded`. Credential-Werte werden nicht
zurueckgegeben. Falls die Audit-Konfiguration bereits als kaputt erkannt wurde,
versucht das Health-Tool nicht zusaetzlich, seine eigene Invocation zu senden;
so bleibt die Diagnose sichtbar.

## Privacy-Allowlist

Audit-Metadaten sind absichtlich information-arm. Die pro Action erlaubten
Keys stehen im Profil oben. Zusaetzlich blockiert `sanitizeMetadata()`
verdachtige Schluesselnamen wie `name`, `filename`, `path`, `content`,
`text`, `hash`, `token`, `credential`, `authorization` oder `secret`, selbst
wenn jemand sie spaeter versehentlich in eine Runtime-Allowlist aufnehmen
wuerde. Strings werden begrenzt und pro Event werden hoechstens 16
Metadatenfelder uebertragen.

Dateiname, Dateipfad, Dateiinhalt, extrahierter Text, Hash-Klartext und
Credential-Werte sind keine Audit-Nutzdaten dieses Produkts.

## Live-Abnahme 2026-09-12

Der Adapter wurde nicht nur mit Mock-Tests, sondern gegen eine **echte,
isolierte** Instanz der auf dem Windows-Testhost installierten
`rheinagent-audit-core 0.2.0rc1` verifiziert. Dabei wurde bewusst ein eigener
Temp-State und Loopback-Port 18766 verwendet; der produktive Mail-Hub auf Port
8766 blieb unberuehrt.

Verifiziert:

- Profil `rheinagent-file-upload@1` wird vom Hub geladen und enthaelt 18 Tools.
- Eigener Test-Service + eigenes Credential authentifizieren erfolgreich.
- `/healthz` und authentifiziertes `/v1/service/health` = healthy.
- Ein echter Invocation-Event wird akzeptiert.
- `file.upload.finalize` durchlaeuft INTENT -> APPLY -> VERIFY -> RESULT.
- Negativtest mit ungueltiger Service-ID beweist Fail-closed vor der Mutation;
  der Mutation-Callback wurde nicht ausgefuehrt.
- Hub `verify` = true.
- Operation `file.upload.finalize` = `complete` / `success`.
- `open_intents` = 0 und Hub-Health = `ok` nach Abschluss.

Der isolierte Hub-Prozess, Temp-State und das Test-Credential wurden danach
vollstaendig entfernt. Diese Abnahme beweist den Produkt-/Hub-Vertrag; sie ist
**keine** produktive Registrierung von `rheinagent-file-upload@1` im zentralen
Kunden-Hub.

Automatisierte Contract-Tests liegen in `test/audit.test.ts` und
`test/audit-profile.test.ts`. Der wiederverwendbare Live-Smoke liegt unter
`scripts/audit-hub-e2e.mjs` und erwartet eine bereits isoliert registrierte
Hub-Service-Konfiguration ueber die oben genannten Umgebungsvariablen.