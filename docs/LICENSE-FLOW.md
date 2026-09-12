# License Flow

## Produktidentitaet

- `product_slug`: `rheinagent-file-upload`
- Package-v2-Profil: `rheinagent-file-upload@1`
- Health-Profil: `rheinagent-file-upload-v1`
- Audit-Profil: `rheinagent-file-upload@1`
- Mindest-Manager fuer die aktuelle Windows-Package-v2-Distribution: `0.4.0-rc.7`

Die Produkt-Runtime besitzt keine Kundenlizenz und kein Manager-Credential. Lizenzierung, Entitlements, geschuetzter Release-Download und Installationsentscheidung gehoeren ausschliesslich in License Service, Update Feed und RheinAgent Manager.

## Verbindlicher Kundenflow

```text
Lizenzcode
  -> RheinAgent Manager
  -> License Service POST /v1/activate
  -> installationsspezifisches Manager-Credential
  -> License Service GET /v1/me/entitlements
  -> Update Feed authorize-update (product/channel/action)
  -> signierter Forgejo-Release (.rapkg + .sig + manifest.json + SHA256SUMS)
  -> Manager Verify -> Prepare -> Activate -> Health -> Commit/Rollback
```

`can_install` und `can_update` sind getrennte Rechte. Zulassige Kanaele sind `stable` und `candidate`. Ein Candidate wird niemals automatisch zu Stable.

## Ownership-Grenzen

**RheinAgent Manager** besitzt Lizenzaktivierung auf dem Arbeitsplatz, Credential-Speicherung, Entitlement-Refresh, Produkt-/Kanalwahl, Package-v2-Verifikation, Fresh-Install, Update, Health und Rollback.

**License Service** besitzt Kunden, Lizenzen, Seats, `rheinagent-file-upload`-Entitlements, Kanalrechte sowie getrennte Install-/Update-Rechte.

**Update Feed** besitzt den geschuetzten Auslieferungspfad und autorisiert jede geschuetzte Asset-Anfrage gegen den License Service. Die Repository-Auswahl bleibt statisch allowlisted; ein Client darf kein beliebiges Forgejo-Repository waehlen.

**File Upload Runtime** besitzt ausschliesslich Produktkonfiguration und Nutzdaten. Insbesondere:

- kein eigener License Store;
- kein Lizenzcode in Runtime-Env, SQLite oder Logs;
- kein Manager-Credential im Produkt;
- kein direkter Forgejo-Kundendownload als Normalpfad;
- keine vom Package frei gewaehlten Install-/Health-Kommandos;
- MCP-Zugriffstoken und Kundenlizenz bleiben getrennte Sicherheitsdomaenen.

## Manager-owned Windows Aktivierung

Die aktuelle Distribution verwendet `windows-versioned-runtime-v1`. Das Package liefert nur den verifizierten Runtime-Payload. Der Manager besitzt die Aktivierung und erzeugt bei Fresh-Install:

- `shared/file-upload.env` mit Loopback-Bindings und standardmaessig `RA_AUDIT_MODE=off`;
- `shared/data`, `shared/logs`, `shared/audit`;
- `manager/health.json` fuer beide HTTP-Liveness-Endpoints und den MCP-Health-Smoke;
- einen festen Scheduled Task `RheinAgent File Upload`;
- einen festen Launcher fuer das gebundelte `node.exe`, `dist/server.js` und `dist/dataplane.js`.

Geschuetzte Pfade sind `shared/file-upload.env`, `shared/audit` und `shared/data`. Das Paket darf diese Bereiche bei Updates nicht ersetzen.

## Cross-Repo-Status

Der Integrationscode ist in den zugehoerigen Arbeitszweigen umgesetzt:

1. License Service akzeptiert `rheinagent-file-upload` als Entitlement-Produkt und die Admin-UI fuehrt es im Produktkatalog.
2. Manager `0.4.0-rc.7` enthaelt das vertraute Profil `rheinagent-file-upload@1`, den Manager-owned Fresh-Install sowie Dual-Plane-/MCP-Health-Pruefung.
3. Update Feed `0.4.1` enthaelt die statische Produktzuordnung auf `rheinagent/rheinagent-file-upload`.
4. Dieses Repo baut und verifiziert Package-v2 fuer Windows x64 und bindet den produktiven Ed25519-Public-Key als Trust Anchor ein.

Quellcode-Integration ist nicht dasselbe wie Release-Publikation: Ein Kunde kann das Produkt erst ueber den Standardflow beziehen, wenn die jeweiligen Aenderungen in ihren kanonischen Repositories angenommen sind und ein produktiv signierter Forgejo-Candidate veroeffentlicht wurde.

## Abnahmekriterium

Der Gesamtflow gilt erst als produktiv abgenommen, wenn alle Punkte nachweislich PASS sind:

- License Service liefert ein `rheinagent-file-upload`-Entitlement fuer einen Testkunden.
- Manager akzeptiert exakt `rheinagent-file-upload@1` und verweigert Profil-Drift.
- Update Feed autorisiert `install`/`update` fuer Produkt und Kanal und bleibt bei unbekannten Produkten fail-closed.
- Ein produktiv signiertes Package-v2 wird vom Manager kryptografisch verifiziert.
- Fresh-Install startet beide Planes, HTTP-Liveness und `rheinagent_file_health_get` sind gruen.
- Ein Update-/Rollback-Test erhaelt `shared/data` und weitere geschuetzte Pfade.
- Audit-Hub-Betrieb wird nur mit explizit fuer `rheinagent-file-upload@1` registriertem Credential aktiviert.
