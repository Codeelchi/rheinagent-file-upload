# License Flow

## Produktidentität

- `product_slug`: `rheinagent-file-upload`
- Package-v2-Profil: `rheinagent-file-upload@1`
- Dieses Dokument spiegelt den bereits produktiv abgenommenen Lizenz-/
  Aktivierungsfluss ("IMPLEMENTIERT / PRODUKTIV ABGENOMMEN" laut
  `rheinagent-manager/docs/LICENSING-ACTIVATION-DESIGN-2026-09-10.md`) für
  dieses neue Produkt — wir treten einer bestehenden, laufenden Plattform
  bei, nicht einem gemeinsamen MVP-Design.

## Verbindlicher Kundenflow

```text
Lizenzcode
  -> RheinAgent Manager
  -> License Service  POST /v1/activate
  -> geschütztes, installationsspezifisches Manager-Credential
  -> License Service  GET /v1/me/entitlements
     {"entitlements": [{"product_slug": "rheinagent-file-upload",
                         "channels": ["stable"],
                         "can_install": true, "can_update": true}]}
  -> Update Feed (AUTH_BACKEND=license_service)
     POST /internal/v1/authorize-update {credential, product_slug, channel, action}
  -> signierter Forgejo-Release (.rapkg + .sig + manifest.json + SHA256SUMS)
  -> RheinAgent Manager: Verify -> Prepare -> Activation -> Health -> ggf. Rollback
```

`can_install` und `can_update` sind getrennte Rechte. Manager/UI dürfen nur
Kanäle anbieten, die der License Service für `rheinagent-file-upload`
explizit zurückgibt.

## Ownership-Grenzen

**RheinAgent Manager besitzt:**
Kunden-Lizenzaktivierung, `manager_instance_id`, das geschützte
Manager-Credential, Entitlement-Refresh, Produkt-/Kanal-/Aktions-Auswahl,
signierten Download über den Update Feed, Package-v2-Verifikation,
Fresh-Bootstrap/Update/Health/Rollback/Registrierung.

**License Service besitzt:**
Kunden/Lizenzen/Seats, `rheinagent-file-upload`-Entitlements, Kanal-Rechte,
getrennte `install`-/`update`-Rechte, Widerruf des Manager-Credentials.

**Update Feed besitzt:**
Geschützte Release-Auslieferung, autorisiert jede geschützte Asset-Anfrage
gegen den License Service. Forgejo ist Release-Speicher/Mirror, **nicht**
der normale Kunden-Download-Pfad.

**Diese Produkt-Runtime besitzt nichts Lizenzbezogenes.** Konkret:

- Kein eigener Lizenz-Speicher
- Keine Lizenzcode-Eingabe in Installer oder Laufzeit
- Das Manager-Credential wird **niemals** in Umgebungsvariablen, Datenbank,
  Datenverzeichnis oder Logs dieses Produkts gespeichert
- Kein direkter Kunden-Download von Forgejo als normaler Pfad
- Kein automatischer Fallback von License Service auf statische
  Produktrechte
- Keine vom Package selbst definierten beliebigen Install-/Health-Befehle
  außerhalb des Manager-eigenen Profils (siehe [VERSIONING.md](VERSIONING.md))
- Keine Aufweichung der festen Service-/Task-Identität
- Kein stillschweigendes Ummünzen alter Audit-Credentials auf eine neue
  Profilversion
- Keine Stable-Promotion eines Candidate ohne separate Release-Entscheidung

Der MCP-Bearer für den Tool-Zugriff dieses Produkts ist eine **getrennte**
Sicherheitsdomäne vom Kunden-Lizenz-Credential — beide werden nie gemischt.

## Repo-Anforderungen für die Umstellung

1. License Service: neue Produktzeile `rheinagent-file-upload` mit
   Kanälen `stable`/`candidate` anlegen (License-Service-Repo, nicht hier).
2. Manager: `rheinagent-file-upload@1` zur vertrauten Profilliste hinzufügen
   (analog zu `rheinagent-knowledge@1`) — Manager-Repo, nicht hier.
3. Update Feed: Produkt-Manifest-Eintrag für `rheinagent-file-upload`
   anlegen — Update-Feed-Repo, nicht hier.

Alle drei Schritte sind in [HANDOFF.md](HANDOFF.md) als offene
Cross-Repo-Arbeit vermerkt; dieses Repo nimmt sie nicht selbst vor.

## Aktueller Migrationsstatus

**Noch nicht eingebunden.** Dieses Produkt existiert als Repo und
Implementierung, ist aber bei Manager/License-Service/Update-Feed noch nicht
registriert. Ein Kunde kann dieses Produkt aktuell nicht über den
Standard-Lizenzfluss installieren, bis Schritte 1–3 oben erledigt sind.

## Abnahmekriterium

Diese Umstellung gilt erst als abgeschlossen, wenn end-to-end nachgewiesen ist:

- [ ] License Service liefert ein Entitlement mit `product_slug:
      "rheinagent-file-upload"` für einen Test-Kunden zurück
- [ ] Manager akzeptiert das Package-v2-Profil `rheinagent-file-upload@1`
      bei Verify/Activation
- [ ] Update Feed autorisiert `install`/`update` für dieses Produkt über
      `authorize-update`
- [ ] Ein Fresh-Install über den Manager erzeugt eine laufende, health-grüne
      Instanz dieses Produkts ohne manuelle Eingriffe außerhalb des
      Manager-Flows
