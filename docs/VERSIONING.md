# Versioning und Distribution

## Kanonische Versionsquelle

`package.json#version` ist die kanonische Produktversion. Aktuell: `0.3.0`.

Ein Git-Release-Tag muss exakt `v<version>` entsprechen. Ein Branch, CI-Artefakt oder lokal gebautes Paket ist niemals automatisch ein Kunden-Release.

## Package-v2-Profil

Die Windows-Distribution ist auf den Manager-Vertrag `rheinagent-file-upload@1` festgelegt:

```json
{
  "contract_version": 1,
  "profile": "rheinagent-file-upload@1",
  "strategy": "windows-versioned-runtime-v1",
  "health_profile": "rheinagent-file-upload-v1",
  "protected_paths": [
    "shared/file-upload.env",
    "shared/audit",
    "shared/data"
  ],
  "persistent_state_globs": ["shared/data/meta/state.sqlite"],
  "service": {
    "windows": {"kind": "scheduled_task", "identity": "RheinAgent File Upload"},
    "linux": {"kind": "systemd", "identity": "rheinagent-file-upload.service"}
  },
  "runtime": {
    "kind": "node-bundled-dual",
    "control_entry": "dist/server.js",
    "data_entry": "dist/dataplane.js",
    "node_executable": "node.exe",
    "minimum_node_major": 22,
    "platform": "windows-amd64"
  },
  "audit_profile": "rheinagent-file-upload@1"
}
```

Die kanonische maschinenlesbare Fassung liegt in `packaging/distribution/activation-contract.json`. `verify_release.py` verlangt exakte Gleichheit; das Package darf keine alternative Aktivierungsstrategie einschleusen. `installers` ist absichtlich `{}`: Fresh-Install und Service-Aktivierung gehoeren dem Manager.

## Windows Runtime Bundle

`packaging/distribution/build_windows_runtime.ps1` baut auf Windows x64 mit Node >=22:

- `node.exe`;
- `dist/server.js` und `dist/dataplane.js`;
- Produktionsabhaengigkeiten aus `package-lock.json`;
- Audit-Profil `audit/rheinagent-file-upload-v1.json`;
- Activation Contract;
- `.runtime-version` und `RHEINAGENT_NODE_RUNTIME.json`.

Optionale npm-Abhaengigkeiten werden bewusst ausgelassen (`npm ci --omit=dev --omit=optional`), weil die optionale native Canvas-Abhaengigkeit von `pdfjs-dist` fuer den hier implementierten PDF-Textpfad nicht erforderlich ist und das Paket unnoetig vergroessert.

## Signierung und Release-Bundle

Ein deliverbares Release besteht exakt aus:

```text
rheinagent-file-upload-<version>.rapkg
rheinagent-file-upload-<version>.rapkg.sig
manifest.json
SHA256SUMS
```

`build_release.py` erzeugt Package-v2 und verlangt standardmaessig Manager >= `0.4.0-rc.7`. `verify_release.py` prueft Signatur, Hashes, Package-Inventar, Pfadsicherheit, Runtime-Identitaet und Activation Contract.

Der im Repo gespeicherte Public Key ist oeffentlich und darf committed werden. Erwarteter SHA-256 der produktiven Public-Key-Datei:

`1c4f5d5ad3313381b7d96d8782c853d950a87ad2f6a285b2c060d325d77e4a15`

Ein privater Produktions-Signierschluessel darf niemals im Repo, in CI-Artefakten oder im Runtime-Paket landen. Die Distribution-CI verwendet ausschliesslich einen ephemeren Testschluessel fuer den Package-Smoke.

## Kanaele

- `candidate`: explizit veroeffentlichter prerelease-Candidate.
- `stable`: separate Promotion/Release-Entscheidung.

Keine automatische Stable-Promotion.

## Lokale Abnahme 2026-09-12

- `npm run check`: 167 Tests, 166 PASS, 1 Windows-Symlink-Privilege-Skip, 0 FAIL.
- TypeScript-Build: PASS.
- Windows Runtime Builder: PASS mit gebundeltem Node 24 und 11 Prozessoren.
- Package-v2-Smoke mit ephemerem Ed25519-Key: PASS.
- Verifiziertes lokales Testpaket: ca. 49.7 MB und damit unter dem 64-MiB-Update-Feed-Limit.
- Produktiver Public-Key-Hash: exakt wie oben.

Diese lokale Signatur ist nur Testevidenz und kein produktiv signierter Release.

## Release Gate

Vor einem Release-Tag muessen mindestens PASS sein:

- `npm run check` und `npm run build`;
- GitHub-CI und Forgejo-CI fuer den exakten Quell-SHA;
- Windows-Runtime-Job und Package-v2-Smoke;
- keine Secrets, `.state/`, `data/`, privaten PEM-Dateien oder CI-Key-Artefakte im Commit;
- Package <= 64 MiB und <= Manager-Limits fuer Dateianzahl/Expanded Size;
- produktive Signierung nur ueber den bestehenden geschuetzten Signierpfad;
- anschliessend Manager Install/Health/Update/Rollback und License/Feed-E2E.

## Release-Historie

Noch kein produktiv freigegebener File-Upload-Release. `0.3.0` ist der aktuelle Source-/Distribution-Candidate; eine spaetere Forgejo-Veroeffentlichung wird hier mit Quell-SHA, Signatur-Key-ID und Kanal dokumentiert.
