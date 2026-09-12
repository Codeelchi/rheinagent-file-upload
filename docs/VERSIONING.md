# Versioning

## Kanonische Versionsquelle

`package.json#version` in diesem Repo ist die kanonische Versionsquelle.
SemVer (`MAJOR.MINOR.PATCH`, Pre-Releases als `-rc.N`). Aktuell: `0.3.0`
(noch nicht bei Manager/License Service/Update Feed registriert — siehe
[LICENSE-FLOW.md](LICENSE-FLOW.md)). Dieser Wert muss bei jeder
`package.json`-Versionsänderung manuell mitgezogen werden — es gibt keine
automatisierte Drift-Prüfung zwischen den beiden Dateien.

`0.2.0` → `0.3.0` (2026-09-11): MINOR wegen echter Feature-Erweiterung
(6 neue Processor, 2 neue Tools — `duplicate_check`,
`knowledge_handoff_prepare` —, neue `mime_category: "office"`) **und**
additiver, aber bei strikter Schema-Validierung sichtbarer Erweiterung von
`CapabilitiesSchema`/`HealthSchema` (neue Pflichtfelder
`product_version`/`state_schema_version`/`processor_registry`/`jobs`).
Da das Produkt noch vor Stable steht (siehe unten, "Release-Historie":
noch kein getaggtes Release), ist das eine zulässige Contract-Bereinigung,
keine nachträgliche Breaking-Change-Behandlung nötig.
Ein Release-Tag in Git muss exakt `v<version>` aus `package.json`
entsprechen; eine Abweichung ist ein Build-Abbruch-Kriterium, nicht etwas,
das die Release-Pipeline stillschweigend korrigiert.

## Package-v2-Konzept

Gemäß `rheinagent-manager/docs/PACKAGE-CONTRACT-V2.md`: ein Package-v2-
Manifest beweist nicht nur Identität/Dateien/Bytes (das leistet schon v1),
sondern deklariert ein **Activation-Objekt**, das der Manager gegen sein
eigenes, versioniertes Profil auf exakte Gleichheit prüft — das Package
wählt weder Task/Unit noch Health-Befehl noch Strategie selbst.

Zielstruktur für `rheinagent-file-upload@1` (noch nicht Manager-seitig
registriert, siehe [HANDOFF.md](HANDOFF.md)):

```json
{
  "contract_version": 1,
  "profile": "rheinagent-file-upload@1",
  "strategy": "<noch mit Manager abzustimmen>",
  "health_profile": "rheinagent-file-upload-v1",
  "protected_paths": ["data/meta/", "data/files/"],
  "persistent_state_globs": ["data/meta/state.sqlite*", "data/files/**"],
  "service": {
    "windows": { "kind": "<tbd>", "identity": "RheinAgent File Upload" },
    "linux": { "kind": "systemd", "identity": "rheinagent-file-upload.service" }
  }
}
```

Dieses Produkt **deklariert** diese Struktur nur — Manager-seitiges
Vertrauen in `rheinagent-file-upload@1` ist eine eigenständige
Manager-Repo-Änderung, nicht Teil dieses Repos. `installers={}` ist der
vorgesehene Ansatz, falls ein Manager-owned Fresh-Bootstrap gewünscht wird
(kein paketseitig gewähltes Installationskommando).

## Release-Kanäle

Ausschließlich `stable` und `candidate`, exakt wie von `rheinagent-update-feed`
vorgegeben. Ein beweglicher Branch ist nie selbst ein Kunden-Release. Jeder
`candidate` muss vor einer `stable`-Promotion eine eigene, explizite
Release-Entscheidung durchlaufen (keine automatische Promotion).

## Release-Metadaten (Bundle-Form)

Exakt die vom Update Feed erwartete Dateimenge pro Release:

```text
rheinagent-file-upload-<version>.rapkg
rheinagent-file-upload-<version>.rapkg.sig
manifest.json
SHA256SUMS
```

Signierung/Upload zum Feed sind Teil der Release-Tooling-Pipeline, nicht
dieses Tool-Repos selbst — dieses Repo liefert nur den Build-Input dafür.

## Update-/Rollback-Vertrag (Zielbild)

Der Manager führt Update/Rollback end-to-end aus (Verify → Prepare →
Activation → Health → Commit/Rollback). Voraussetzung auf unserer Seite:
`persistent_state_globs` im Package-v2-Manifest müssen exakt die Pfade
abdecken, die ein Rollback erhalten muss (`data/meta/state.sqlite*` —
Haupt-DB-Datei plus WAL-/SHM-Sidecar-Dateien, siehe
[STATE-MIGRATION.md](STATE-MIGRATION.md) — und `data/files/**`),
und `protected_paths` dürfen von einem Update nicht überschrieben werden.
Diese Felder sind oben als Zielstruktur benannt, aber noch nicht gegen einen
echten Manager-Update-Lauf verifiziert. Der laufende Dienst kann den physischen
Data-Root ?ber `RHEINAGENT_FILE_UPLOAD_DATA_DIR` verlagern; ein sp?teres
Manager-Package muss diesen tats?chlichen Installationspfad auf die logischen
`data/...`-Protected-/Persistent-Globs abbilden. Vor Update/Rollback senden die
Prozesse auf `SIGTERM` einen kontrollierten HTTP-Shutdown und schlie?en ihre
SQLite-Handles.

## Health/Doctor-Konzept

Health-Profil `rheinagent-file-upload-v1`, seit 2026-09-11 implementiert als
Tool `rheinagent_file_health_get` (siehe [ARCHITECTURE.md](ARCHITECTURE.md)):

- `control_plane_reachable` (per Definition `true` — das Tool antwortet
  gerade) ✅
- `data_plane_reachable` (`GET /healthz` auf Port 3902, 2 s Timeout) ✅
- `staging_dir_writable`, `files_dir_writable` (`fs.access(dir, W_OK)`,
  keine Probe-Datei) ✅
- `audit_mode` + bei `hub`: **welche** Config-Variablen gesetzt sind
  (`endpoint_configured`/`service_id_configured`/`credential_path_configured`)
  und `hub_endpoint_reachable` als bewusst protokoll-loser
  Best-Effort-Netzwerkcheck ✅ — **noch offen**: Service-Registrierung,
  Protokoll-Kompatibilität und Anzahl offener/unvollständiger Operationen
  gegen eine echte Hub-Instanz (braucht die in [HANDOFF.md](HANDOFF.md)
  Punkt 4 beschriebene Cross-Repo-Registrierung zuerst)

Kein Health-Check darf je Dateiinhalte, Hashes einzelner Dateien oder
Audit-Credentials zurückgeben — eingehalten: `hub_endpoint_reachable` prüft
nur Netzwerk-Erreichbarkeit ohne Credential im Request.

## Schema-Kompatibilität

`FileRecord`/`JobRecord`/`PendingUpload`/`DeleteTicket` (`src/lib/store.ts`)
sind interne JSON-Strukturen ohne eigene Versionsfelder in v1 — ein
künftiges Breaking-Change an diesen Strukturen braucht eine Migrationsnotiz
hier, bevor es gemacht wird.

## Release-Gate

Vor jedem Release-Tag:

- [ ] `npm run check` fehlerfrei (= `tsc --noEmit` + alle automatisierten Tests unter `test/`)
- [ ] GitHub-CI `docker-runtime-smoke` gr?n: echter Compose-Start beider Planes, Upload/Extraction/Duplicate/Knowledge-Handoff/Download und Persistenzpr?fung nach Container-Restart
- [ ] Manuelle End-to-End-Probe aller 18 Tools (siehe [BUILDLOG.md](../BUILDLOG.md)
      für das zuletzt dokumentierte Ergebnis) — automatisierte Tests ersetzen
      das noch nicht vollständig, siehe [HANDOFF.md](HANDOFF.md) zum aktuellen
      Abdeckungsstand
- [ ] `BUILDLOG.md` aktualisiert
- [ ] Kein Secret, kein `data/`-Inhalt im Diff (`git status` vor jedem Commit)

## Release-Historie

Noch kein getaggtes Release. Erster Eintrag folgt mit `v<package.json#version>`,
sobald die in [LICENSE-FLOW.md](LICENSE-FLOW.md) gelistete Cross-Repo-
Registrierung zumindest für einen Test-Kunden durchgeführt wurde.
