# Processors

Stand: 2026-09-11. Vollständige Referenz aller in `src/lib/processors.ts`
registrierten Processor. Jeder Processor ist eine fest im Code registrierte
TypeScript-Funktion (Allowlist, siehe [SECURITY.md](SECURITY.md), "Keine
beliebigen Executor-Tools") — `rheinagent_file_process_apply` kann nur einen
dieser `processor_id`-Werte wählen, nie beliebigen Code ausführen.

`rheinagent_file_capabilities_get`s `processors`-Feld liefert dieselbe
Liste maschinenlesbar (`{id, supported_mime_categories}`), damit ein
Client nicht raten muss, welcher `processor_id` zu welcher Datei passt.

## `text` (`.txt`/`.md`/`.csv`/`.json`)

| processor_id | Extension-Pflicht | Optionen | Ausgabe |
|---|---|---|---|
| `text_stats` | keine | — | `line_count`, `word_count`, `char_count` |
| `text_uppercase` | keine | — | `transformed_text` (kompletter Dateiinhalt, großgeschrieben) |
| `text_extract` | keine | `offset?`, `limit?` (Chunking, s. u.) | `text`, `char_count`, `word_count`, `line_count`, `truncated`, `total_chars`, `next_offset` |
| `markdown_structure` | `.md` | — | `headings` (`{level, text}[]`), `links_count`, `code_block_count` |
| `csv_inspect` | `.csv` | `delimiter?: string` (1 Zeichen) | `delimiter`, `row_count`, `column_count`, `headers`, `sample_rows` (max. 20), `truncated` |
| `json_inspect` | `.json` | — | `root_type`, `array_length`, `keys` (max. 50), `keys_truncated`, `sample`, `sample_truncated` |

`mime_category: "text"` deckt vier verschiedene Extensions ab (siehe
[ARCHITECTURE.md](ARCHITECTURE.md)/[SECURITY.md](SECURITY.md) — das
Kategorienmodell ist bewusst grob, nicht pro Extension). `csv_inspect`,
`json_inspect` und `markdown_structure` sind deshalb zusätzlich zur
`mime_category`-Prüfung auf die passende Dateiendung angewiesen
(`requireExtension()` in `processors.ts`) — ein `csv_inspect` gegen eine
`.txt`-Datei scheitert mit einer klaren Fehlermeldung, nicht mit einem
stillen Fallback oder einem falschen Ergebnis.

**CSV-Limits**: maximal 5000 gescannte Zeilen (`truncated: true` danach),
maximal 20 Beispielzeilen in der Antwort, jede Zelle auf 500 Zeichen
gekappt. Delimiter-Erkennung zählt Vorkommen von `,`/`;`/Tab in der ersten
Zeile; `options.delimiter` überschreibt das explizit.

**JSON-Limits**: ein Bracket-Tiefen-Scan über den rohen Text läuft **vor**
`JSON.parse()` und lehnt alles jenseits von 64 Verschachtelungsebenen ab —
`JSON.parse`s eigener rekursiver Abstieg ist der eigentliche
Stack-Overflow-Risikofaktor bei extrem tiefem JSON, dieser Scan verhindert,
dass so ein Input je an den echten Parser geht.

## `pdf`

| processor_id | Optionen | Ausgabe |
|---|---|---|
| `pdf_metadata` | — | `page_count`, `pdf_format_version`, `title`, `author` |
| `pdf_extract_text` | `page?: number` (1-indiziert) | `extracted_text` (bis 64 KiB), `page_count`, `page`, `truncated` |

Via `pdfjs-dist` (Begründung siehe [SECURITY.md](SECURITY.md)).
`options.page` extrahiert eine einzelne Seite statt des ganzen Dokuments —
der Workaround für PDFs über der 64-KiB-Ergebnisgrenze.

## `image`

| processor_id | Ausgabe |
|---|---|
| `image_metadata` | `format` (`png`/`jpeg`), `width`, `height`, `size_bytes` |

Hand-geparste PNG-/JPEG-Header, keine Bildbibliothek (siehe
[SECURITY.md](SECURITY.md)).

## `office` (`.docx`/`.xlsx`, seit 2026-09-11)

| processor_id | Extension-Pflicht | Optionen | Ausgabe |
|---|---|---|---|
| `docx_extract_text` | `.docx` | `offset?`, `limit?` (Chunking, s. u.) | `text`, `paragraph_count`, `table_count`, `truncated`, `total_chars`, `next_offset` |
| `xlsx_inspect` | `.xlsx` | `sheet?: string` (Blattname) | `sheet_names`, `sheet`, `row_count`, `column_count`, `headers`, `sample_rows` (max. 20), `shared_strings_truncated`, `truncated` |

Beide via `src/lib/officeZip.ts` + `src/lib/officeXml.ts` — kein
allgemeiner ZIP-/XML-Parser, siehe [SECURITY.md](SECURITY.md) für die volle
Begründung (kein Filesystem-Schreiben, bounded Inflate, kein XXE-Risiko).
`xlsx_inspect` ohne `options.sheet` liest das erste Arbeitsblatt; ein
unbekannter Blattname scheitert mit der Liste der tatsächlich vorhandenen
Namen.

**Limits**: 20 MiB pro entpacktem ZIP-Entry, 40 MiB kumulativ pro Aufruf,
maximal 5000 Central-Directory-Einträge, maximal 20 000 Shared Strings,
maximal 5000 gescannte Zeilen / 20 Beispielzeilen / 500 Zeichen pro Zelle
bei `xlsx_inspect`.

## Chunking (seit 2026-09-11)

`text_extract` und `docx_extract_text` — die beiden Processor für
unpaginierten, potenziell beliebig langen Fließtext — akzeptieren
`options.offset` (Zeichenindex in den vollständigen extrahierten Text,
Default `0`) und `options.limit` (wie viele Zeichen ab dort, Default und
Maximum die jeweilige `*_MAX_CHARS`-Konstante). Ein Client liest ein
beliebig langes Dokument vollständig, indem er wiederholt
`offset = vorheriger next_offset` aufruft, bis `next_offset: null`
zurückkommt (dann ist `truncated: false` für dieses letzte Fenster). Das ist
derselbe Zweck wie `pdf_extract_text`s `options.page` (dort ist "eine Seite"
die natürliche Chunk-Einheit; bei DOCX/reinem Text, die kein natives
Seitenkonzept haben, ist "ein Zeichenfenster" die Einheit) und wie
`xlsx_inspect`s zeilenbasiertes Sample — alle drei lösen dasselbe Problem
("ein 100-Seiten-Dokument muss vollständig analysierbar sein, ohne einen
riesigen MCP-Response zu erzeugen") mit dem jeweils zum Format passenden
Chunk-Begriff, statt eine gemeinsame künstliche Chunk-Entität über alle
Formate zu stülpen, die für keines davon wirklich passt.

`docx_extract_text` scannt intern bis zu 10 MiB extrahierten Text (deutlich
über der 64-KiB-Fensterbreite), damit auch ein sehr langes Dokument
vollständig chunk-weise erreichbar bleibt, nicht nur die ersten 64 KiB.
Ein Dokument, dessen Text selbst diese 10-MiB-Scangrenze überschreitet,
bleibt bis dorthin lesbar (`truncated: true` markiert dann sowohl "mehr im
aktuellen Fenster" als auch "mehr jenseits der Scangrenze").

**Noch nicht umgesetzt**: eine eigene Cursor-Paginierung für `csv_inspect`/
`xlsx_inspect` über die aktuell feste 20-Zeilen-Stichprobe hinaus (aktuell
nur über `options.sheet` bei mehreren Arbeitsblättern navigierbar) — bei
Bedarf ein naheliegender nächster Schritt nach demselben `offset`/`limit`-
Muster, aber für dieses Repo aktuell kein bekanntes reales Bedürfnis
(bisherige Live-Tests brauchten nie mehr als die Stichprobe).

## Prozessor-übergreifende Konventionen

- Ein unbekannter/falsch-geformter `options`-Wert scheitert als klarer
  Job-Fehler (`state: "failed"`, `error`-Feld), nie als stiller Fallback.
- Jedes `*_extract*`/`*_text`-Ergebnis, das potenziell großen Inhalt
  zurückgibt, trägt ein `truncated: boolean`-Feld — ein Client kann so
  unterscheiden "das ist der komplette Inhalt" von "das ist nur ein
  Ausschnitt, für mehr siehe [PROCESSORS.md](PROCESSORS.md)/Chunking"
  (siehe auch [ARCHITECTURE.md](ARCHITECTURE.md) zum aktuellen Stand der
  Chunk-Unterstützung für sehr große Dokumente).
- Kein Processor schreibt außerhalb von `data/results/<job_id>.json`
  (verwaltet von `store.ts`, nicht vom Processor selbst).
