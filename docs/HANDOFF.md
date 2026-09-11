# Handoff

Stand: 2026-09-11. Dieses Dokument listet **alles**, was außerhalb von
`Codeelchi/rheinagent-file-upload` erledigt werden muss, bevor dieses Produkt
für echte Kunden nutzbar ist. Dieses Repo nimmt keine der folgenden Änderungen
selbst vor — ausschließlich schreibend in diesem Repo, wie vorgegeben.

## Einstieg für eine neue Session

- Letzter Commit auf `main`: `3c7fb9e` ("Migrate to MCP protocol 2026-07-28
  and close spec-compliance gaps") — Arbeitsverzeichnis zum Zeitpunkt dieses
  Eintrags sauber, lokal = `origin/main`, keine offenen Änderungen.
- Lokaler Checkout: `/home/Technowolf/mcp-ui-test` auf `berry`.
- Server starten: `npm run serve` (Control Plane, Port 3901) **und**
  `npm run serve:dataplane` (Data Plane, Port 3902) — beide nötig für Uploads.
  `npm test` für die 26 automatisierten Tests, `npx tsc --noEmit` für den Typecheck.
- Arbeits-Workflow für dieses Repo (siehe auch Memory
  `feedback_mcp_ui_test_workflow`): jede Änderungsrunde endet mit einem
  `BUILDLOG.md`-Eintrag + Push nach `github.com/Codeelchi/rheinagent-file-upload`,
  ohne dass der Nutzer danach fragen muss.
- **Wichtigster nächster fachlicher Schritt:** Audit-Hub-Live-Verifikation
  (`src/lib/audit.ts` ist nur gegen die Dokumentation implementiert, nie
  gegen eine laufende `rheinagent-audit`-Instanz getestet) — siehe Abschnitt
  "Offene Cross-Repo-Integrationsarbeit" Punkt 4 unten.
- Vollständiger aktueller Funktionsstand: alle 11 Tools implementiert und
  end-to-end verifiziert (Upload/Process/Delete-Flow, Pagination,
  Elicitation-Bestätigung, Legacy- und moderner `2026-07-28`-Protokollpfad).
  Details: `BUILDLOG.md` (neuester Eintrag oben).

## Verbindlicher License-/Distribution-Flow (Referenz)

Siehe [LICENSE-FLOW.md](LICENSE-FLOW.md) für den vollständigen Fluss. Dieses
Produkt ist Stand heute **nicht** in diesen Fluss eingebunden.

## Source of truth

GitHub (`Codeelchi/rheinagent-file-upload`, Branch `main`). Referenzstand der
gelesenen Plattform-Repos bei Implementierung dieser Version:

| Repo | Commit (main) |
|---|---|
| `rheinagent-manager` | `ef01dacdcf992dffdecb0615c559844f67d54e3d` |
| `rheinagent-license` | `63064382633050bf8d5e89239defb8bfbecaff24` |
| `rheinagent-update-feed` | `7848fe0d58683e34a3edf56d0b8525aebf5c58f2` |
| `rheinagent-audit` | `eb6765ed2c5e59ae9ae66021211e02fed66fae6a` |
| `rheinagent-knowledge-mcp` | `ab7308a632f60c89b17fdf9dc175d96e7b54a386` |
| `rheinagent-backoffice` | `a518dafe94497b72fcde7f305e481e4b5dd55561` |

**Diese SHAs sind bewusst nicht als dauerhaft gültig zu behandeln** — vor
jeder künftigen Änderung an diesem Produkt, die sich auf einen der obigen
Verträge stützt, erneut den aktuellen `main`-Stand prüfen.

## Offene Cross-Repo-Integrationsarbeit

### 1. `rheinagent-license`
- Neue Produktzeile `product_slug: "rheinagent-file-upload"` mit Kanälen
  `stable`/`candidate` anlegen.
- Mindestens ein Test-Entitlement (`can_install: true, can_update: true`)
  für einen Test-Kunden erzeugen, um den Abnahmekriterien-Flow aus
  [LICENSE-FLOW.md](LICENSE-FLOW.md) durchspielen zu können.

### 2. `rheinagent-manager`
- `rheinagent-file-upload@1` zur vertrauten Package-v2-Profilliste
  hinzufügen (Code-Review-pflichtig laut `PACKAGE-CONTRACT-V2.md`) — exakte
  Strategie/Service-Identität für Windows noch offen, siehe
  [VERSIONING.md](VERSIONING.md) Zielstruktur.
- Entscheidung treffen: `installers={}` (Manager-owned Fresh-Bootstrap) oder
  klassischer Strategie-Pfad wie bei Mail/Knowledge.

### 3. `rheinagent-update-feed`
- Produkt-Manifest-Eintrag für `rheinagent-file-upload` anlegen, inkl.
  Kanal-Routing `stable`/`candidate`.

### 4. `rheinagent-audit`
- Audit-Profil `rheinagent-file-upload@1` mit der in [AUDIT.md](AUDIT.md)
  dokumentierten Allowlist-Tabelle serverseitig registrieren.
- Service-Credential für dieses Produkt ausstellen (eigene Service-Chain).
- **Den implementierten Write-Ahead-Client (`src/lib/audit.ts`) gegen eine
  echte Hub-Instanz verifizieren** — bisher nur gegen die Dokumentation
  implementiert, nie live getestet. Das ist der wichtigste offene technische
  Punkt dieses Handoffs.

## Plattform-Inkonsistenzen (beim Lesen der Referenz-Repos gefunden, nicht hier gelöst)

1. **Audit-Endpoint-Variablenname uneinheitlich**: `rheinagent-backoffice`
   nutzt `RA_AUDIT_ENDPOINT`, `rheinagent-knowledge-mcp` nutzt
   `RA_AUDIT_HUB_URL`. Dieses Produkt folgt `backoffice`. Eine
   plattformweite Vereinheitlichung wäre Sache von `rheinagent-audit`
   selbst (Dokumentation/SDK), nicht dieses Produkts.
2. Die Produktvorgabe für dieses Repo nannte `Codeelchi/rheinagent-mail-mcp`
   als Referenz-Repo — der tatsächliche Name ist `Codeelchi/mailmcp`. Für
   künftige Architektur-Checks den korrekten Namen verwenden.

## Innerhalb dieses Repos noch offen (nicht Cross-Repo, aber unerledigt)

- **Kein Download-Endpunkt für große/binäre Dateien.** `rheinagent_file_get`
  liefert Inhalt nur für kleine Textdateien inline; ein Data-Plane-GET-Pfad
  für größere/binäre Downloads fehlt noch.
- **Kein Docker-Setup** für Control-/Data-Plane als zwei Services.
- **Kein Health-/Doctor-Tool implementiert** — nur als Zielbild in
  [VERSIONING.md](VERSIONING.md) beschrieben.
- **Keine MCP-App-UI** für die aktuelle Tool-Menge (der frühere Prototyp mit
  anderen Tool-Namen wurde entfernt, siehe [BUILDLOG.md](../BUILDLOG.md)).
  UI ist laut Vorgabe optional — Business-Funktionen sind vollständig ohne
  UI nutzbar; eine Wiederanbindung ist rein additiv und blockiert nichts.
- **Kein automatisierter CI-Lauf** — Tests existieren unter `test/` (siehe
  [VERSIONING.md](VERSIONING.md) Release-Gate), laufen aber aktuell nur
  manuell per `npm test`.
- **Archiv-/Entpack-Processor nicht vorhanden** — Archivformate werden
  komplett abgelehnt (siehe [SECURITY.md](SECURITY.md)); sobald ein
  Entpack-Processor gewünscht ist, müssen dafür echte Archive-Bomb-Limits
  (Tiefe, Gesamtgröße entpackt, Dateianzahl) neu entworfen werden.
- **Keine Mandanten-/Nutzertrennung** — einzige, geteilte Namespace pro
  Instanz (siehe [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md)).

## 2026-09-11 erledigt (vorher hier offen gelistet)

- **SDK-Migration auf Protokoll `2026-07-28`** — `@modelcontextprotocol/server`
  + `@modelcontextprotocol/node` (v2) statt des alten
  `@modelcontextprotocol/sdk` (max. `2025-11-25`). Legacy- und moderne
  Clients laufen über denselben `/mcp`-Endpunkt (`createMcpHandler`-Shim
  bestätigt getestet gegen `2025-06-18`-Handshake und `2026-07-28`-stateless-
  Requests inkl. `Mcp-Method`/`Mcp-Name`-Headern).
- **`outputSchema` für alle 11 Tools** (`src/lib/schemas.ts`, zod → JSON Schema).
- **Tool-Annotations** (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`).
- **Rate-Limiting** (`src/lib/rateLimit.ts`, pro Tool-Name, 3 Gewichtsklassen) — vorher 0 % umgesetzt, jetzt Pflichtanforderung der Spec erfüllt.
- **Pagination für `rheinagent_file_list`** (`cursor`/`next_cursor`, deterministische Sortierung).
- **Elicitation-Bestätigung vor `delete_apply`** (Multi-Round-Trip, `InputRequiredResult` → `elicitation/create` → `inputResponses`) — live End-to-End getestet (ohne Bestätigung → `input_required`, mit Bestätigung → tatsächliche Löschung).
- **Strukturiertes Logging** (`src/lib/logging.ts`, stderr-JSON) statt `console.log` — bewusst **nicht** über die MCP-`notifications/message`-Utility, da diese laut Spec (SEP-2577) für `2026-07-28` deprecated ist.

**Noch nicht umgesetzt aus der ursprünglichen Verbesserungsliste:**
Resource-Exposure (`resources/list`/`resources/read` für Dateien, zusätzlich
zu den Tools) — bewusst zurückgestellt, da additiv und nicht
sicherheitskritisch.

## Nächster Schritt nach jedem obigen Punkt

Reihenfolge-Empfehlung: (1) Audit-Hub-Live-Verifikation, weil sie die
Kernarchitektur bestätigt, bevor mehr draufgebaut wird → (2) License/Manager/
Update-Feed-Registrierung, weil sie Voraussetzung für jeden echten
Kunden-Test ist → (3) Download-Endpunkt, weil er die Hauptlücke der
aktuellen Tool-Funktionalität ist → (4) Health/Doctor + Docker, weil sie den
Betrieb erleichtern, aber nichts Funktionales freischalten → (5) UI-
Wiederanbindung, da explizit optional.
