# Installation & Betrieb

## Laufzeit-Umgebungsvariablen

| Variable | Default | Zweck |
|---|---|---|
| `RHEINAGENT_FILE_UPLOAD_MAX_BYTES` | `26214400` (25 MiB) | Upload-Größenlimit, geprüft in Prepare, beim Stream in der Data Plane und erneut beim Finalize |
| `RHEINAGENT_FILE_UPLOAD_DATAPLANE_PORT` | `3902` | Port der Data Plane; muss mit dem tatsächlich gestarteten `dataplane.ts`-Port übereinstimmen |
| `RHEINAGENT_FILE_UPLOAD_DATAPLANE_HOST` | `localhost` | Hostname, über den die Control Plane die Data Plane erreicht (intern für `health_get` **und** für die an den Client zurückgegebenen `upload_url`/`download_url`) — nur ändern, wenn beide Prozesse tatsächlich nicht über `localhost` erreichbar sind (siehe `docker-compose.yml`, das stattdessen `network_mode: host` nutzt, damit `localhost` in beiden Containern weiterhin dasselbe bedeutet) |
| `RHEINAGENT_FILE_UPLOAD_BIND_HOST` | `127.0.0.1` | Bind-Host für **beide** Prozesse. Diese Version hat kein TLS/Auth auf HTTP-Ebene (siehe [SECURITY.md](SECURITY.md)) — nur explizit auf `0.0.0.0` o.ä. ändern, wenn ein Reverse Proxy/andere Zugriffskontrolle davorsteht |
| `RA_AUDIT_MODE` | `off` | `off` oder `hub` — siehe [AUDIT.md](AUDIT.md) |
| `RA_AUDIT_ENDPOINT` | — | nur bei `hub` erforderlich |
| `RA_AUDIT_SERVICE_ID` | — | nur bei `hub` erforderlich |
| `RA_AUDIT_CREDENTIAL_PATH` | — | nur bei `hub` erforderlich, Pfad zu einer Datei mit dem Service-Credential |
| `RA_AUDIT_PROTOCOL_VERSION` | `rheinagent-audit/1` | selten zu ändern |

Die Control Plane (`server.ts`, Port 3901) und die Data Plane
(`dataplane.ts`, Port 3902) sind zwei separate Prozesse — beide müssen
laufen, damit Uploads funktionieren.

## Lokale Entwicklung

```bash
npm install
npm run serve             # Control Plane
npm run serve:dataplane   # Data Plane, separat
```

Beide schreiben/lesen `data/` relativ zum Projektverzeichnis
(`staging/`, `files/`, `results/`, `meta/*.json`) — per `.gitignore`
ausgeschlossen, nie Teil eines Commits.

## Audit-Opt-in

Standardmäßig `RA_AUDIT_MODE=off` — keine Konfiguration nötig, Produkt
funktioniert vollständig ohne Audit Hub. Für `hub`-Betrieb: Hub-Erreichbarkeit
und Service-Registrierung sind Voraussetzung, bevor `RA_AUDIT_MODE=hub`
gesetzt wird — ohne gültiges Credential schlagen kritische Schreiboperationen
fail-closed fehl (siehe [AUDIT.md](AUDIT.md)). Es gibt **keinen** automatischen
Fallback von `hub` zurück auf `off`, falls der Hub nicht erreichbar ist — das
ist beabsichtigt (fail-closed, ADR-004).

## Windows Fresh-Install-Vertrag (Zielbild)

Dieses Repo installiert sich nicht selbst — ein Fresh Install läuft
ausschließlich über den RheinAgent Manager (siehe [LICENSE-FLOW.md](LICENSE-FLOW.md)
und [VERSIONING.md](VERSIONING.md) für den Package-v2-Vertrag). Diese
Version deklariert noch keinen konkreten `service`-Block für Windows/Linux
im Package-v2-Manifest — das ist zurückgestellt, bis die
Aktivierungs-Objekt-Struktur mit dem Manager abgestimmt ist (siehe
[HANDOFF.md](HANDOFF.md)). Bis dahin ist nur der manuelle Betrieb oben
("Lokale Entwicklung") verfügbar.

## Docker

Seit 2026-09-11 vorhanden: `Dockerfile` (Multi-Stage — Build-Stage mit
`npm ci` + `tsc`, Runtime-Stage nur mit `npm ci --omit=dev`, kein `tsx`/
`typescript` im Runtime-Layer) + `docker-compose.yml` (zwei Services,
`file-control`/`file-data`, aus demselben Image, gemeinsames Volume
`rheinagent-file-upload-data` für `/app/data`).

```bash
docker compose up --build
```

Sicherheitsmaßnahmen im Compose-Setup: `read_only: true` (Root-Dateisystem),
`cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, non-root
`rheinagent`-User im Image, `network_mode: host` (Linux — siehe
`docker-compose.yml`-Kommentar für die Begründung: damit `localhost`
zwischen den beiden Containern dasselbe bedeutet wie im nicht-containerisierten
Betrieb, ohne einen zweiten Hostname für interne vs. extern beworbene
`upload_url`/`download_url` pflegen zu müssen), Docker-`HEALTHCHECK` gegen
das neue `/healthz`-Control-Plane-Endpoint (analog zum bereits vorhandenen
Data-Plane-`/healthz`). Kein Supervisor-Prozess in einem gemeinsamen
Container — bewusste Entscheidung, siehe Kommentar in `docker-compose.yml`:
Docker/Compose ist bereits der Prozessmanager, ein zusätzlicher Supervisor
wäre unnötige Komplexität und eigene Angriffsfläche für ein Produkt, dessen
Architektur ohnehin zwei getrennte Prozesse vorsieht.

**Verifikationsstand**: `docker build`/`docker compose up` **nicht** gegen
einen echten Docker-Daemon getestet — diese Session hatte nur den
`docker`-CLI-Client, keinen laufenden Daemon zur Verfügung
(`docker compose config` validiert die Compose-Datei syntaktisch fehlerfrei,
das ist alles, was ohne Daemon möglich war). Der kompilierte Build selbst
(`npm run build` → `node dist/server.js`/`node dist/dataplane.js`) wurde
außerhalb von Docker live verifiziert (Control Plane startet, beantwortet
`/mcp`). **Vor Produktivbetrieb**: einmal `docker compose up --build` gegen
einen echten Daemon fahren und den vollen Upload→Process→Download-Flow
durchspielen — das ist noch offen.

## Doctor / Health

`rheinagent_file_health_get` implementiert das Health-Profil
`rheinagent-file-upload-v1` (Konzept: [VERSIONING.md](VERSIONING.md),
Implementierungsdetails: [ARCHITECTURE.md](ARCHITECTURE.md)): Plane-
Erreichbarkeit, Staging-/Files-Verzeichnis-Schreibbarkeit, und im
`hub`-Audit-Modus die Vollständigkeit der Audit-Konfiguration plus einen
Best-Effort-Netzwerkcheck des Hub-Endpunkts. Es gibt noch keinen separaten
`doctor`-CLI-Befehl außerhalb des MCP-Tools.
