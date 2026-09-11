# Knowledge Integration

Stand: 2026-09-11. Referenzstand des gelesenen `rheinagent-knowledge-mcp`
bei Implementierung: `main` @ `ab7308a` (siehe auch die SHA-Tabelle in
[HANDOFF.md](HANDOFF.md) — vor jeder künftigen Änderung erneut prüfen, ob
sich der Contribution-Contract dort geändert hat).

## Ziel

Eine hochgeladene und analysierte Datei soll als Vorschlag für eine
Knowledge-Contribution nutzbar sein, **ohne** den Contribution-/Review-/
Publish-Flow von `rheinagent-knowledge-mcp` zu umgehen. Dieses Produkt
besitzt kein Knowledge-Credential, keine Knowledge-Tenant-Identität und
kann nicht wissen, welche Data-Scopes der aufrufende Principal dort
gewährt bekommen hat — es ruft Knowledge **nie selbst auf**.

## Der reale Contribution-Contract (verifiziert gegen `main`)

`knowledge_contribution_create` (der einzige Weg, eine neue Contribution
anzulegen) akzeptiert **ausschließlich**:

```
{
  topic: string (1-240 Zeichen, Pflicht),
  department: string (1-120 Zeichen, Pflicht),
  scope: string (1-120 Zeichen, Pflicht),
  answers: {question, answer}[] (max. 100),
  statements: {text}[] (max. 100, je max. 5000 Zeichen)
}
```

Wichtige Erkenntnisse aus der Recherche gegen den echten Code (nicht nur
Dokumentation):

- **Kein `title`/`content`/`tags`/`classification`-Feld bei Contribution-
  Erstellung.** Diese Felder existieren dort überhaupt nicht auf
  `contribution_create` — `tags`/`classification` sind erst *nach*
  Indexierung/Publikation über `knowledge_document_metadata_update`
  setzbar. Ein Handoff, der diese Felder anbietet, wäre ein Vertrag, den
  Knowledge gar nicht entgegennimmt.
- **`scope` ist kein freier Text, sondern muss einer bereits dem
  aufrufenden Principal gewährten Data-Scope entsprechen**
  (`contributionScopeAllowed()` in Knowledge prüft
  `principal.dataScopes.has(scope)`). Data-Scopes werden serverseitig
  über Knowledges eigene Policy-Tools vergeben, nicht vom Client
  behauptet. Dieses Produkt kennt diese Zuweisung nicht und **darf** sie
  nicht erfinden — ein erfundener Wert würde entweder abgelehnt oder,
  schlimmer, zufällig einen Scope treffen, für den diese Datei nie
  autorisiert war.
- **`department` hat in diesem Produkt keine Quelle.** Es gibt keinen
  Wert, aus dem sich ein sinnvolles `department` ableiten ließe.

## `rheinagent_file_knowledge_handoff_prepare`

Neues, rein lesendes Tool (`src/lib/knowledgeHandoff.ts`,
`server.ts`). Eingabe: `file_id` (Pflicht), `extraction_job_id?`
(optional — ein bereits abgeschlossener Extraction-Job für dieselbe
Datei, z. B. von `text_extract`/`docx_extract_text`/`pdf_extract_text`).

Ausgabe: ein `contribution`-Objekt in **exakt** der oben dokumentierten
Knowledge-Form:

- `topic`: der Dateiname (Vorschlag, vom Aufrufer änderbar) — nie
  erfunden, direkt aus dem `FileRecord`.
- `department`/`scope`: **immer `null`**, zusammen mit einem Eintrag in
  `requires_user_input` — niemals erraten oder aus Heuristiken abgeleitet.
- `answers`: immer `[]` (dieses Produkt hat keine Frage-/Antwort-Paare).
- `statements`: aus dem Textergebnis des übergebenen `extraction_job_id`
  (Feld `text`, das jeder relevante Extraction-Processor einheitlich
  liefert, siehe [PROCESSORS.md](PROCESSORS.md)), auf Absatzgrenzen
  gesplittet und auf Knowledges eigene Grenzen (max. 100 Statements, je
  max. 5000 Zeichen) begrenzt — der Aufrufer kann das Ergebnis ohne
  weiteres eigenes Chunking direkt an `knowledge_contribution_create`
  weiterreichen. Ohne `extraction_job_id` bleibt `statements: []` mit
  einer erklärenden `warnings`-Meldung.

`ready: true` bedeutet **nur** "dieser Vorschlag trägt echten Content" —
**nicht** "sicher automatisch einreichbar". `department`/`scope` fehlen
strukturell immer, `ready` sagt darüber nichts aus. Es gibt keinen
automatischen Übergang von diesem Tool zu
`knowledge_contribution_create`/`_submit` — das bleibt eine bewusste
Entscheidung des aufrufenden Agenten/Nutzers, mit dessen eigener
Knowledge-Identität.

## Bewusst nicht umgesetzt

- **Kein direkter Tool-Aufruf gegen `rheinagent-knowledge-mcp`.** Dieses
  Produkt hat kein Machine-Credential dafür und soll keins bekommen (siehe
  [ARCHITECTURE.md](ARCHITECTURE.md) Abschnitt 6 der ursprünglichen
  Zielvorgabe: lose Kopplung, Benutzeridentität bleibt beim aufrufenden
  Client).
- **Keine automatische Scope-/Department-Zuordnung**, auch nicht über
  eine Konfigurationsdatei dieses Produkts — beides ist Knowledge-seitige
  Autorität.
- **Kein Cursor/Batch für sehr viele Dateien auf einmal.** Ein Aufrufer
  ruft das Tool pro Datei einzeln auf, konsistent mit jedem anderen
  file_id-bezogenen Tool in diesem Produkt.
