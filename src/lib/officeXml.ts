/**
 * Narrow, hand-rolled OOXML text extraction — NOT a general XML parser.
 * Every function here does a bounded regex/string scan for a fixed,
 * well-known tag shape (docx `<w:t>`, xlsx `<sheet>`/`<si>`/`<row>`) and
 * ignores everything else in the document, including any `<!DOCTYPE>` or
 * entity declaration. That's a deliberate security property, not a
 * shortcut: a real XML parser that resolves external/general entities is
 * how XXE happens. This code never looks at, resolves, or expands an XML
 * entity beyond the five predefined ones (`&amp; &lt; &gt; &quot; &apos;`)
 * plus numeric character references — there is no mechanism here that
 * could ever read a local file or make a network request while parsing.
 */

function unescapeXmlEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g, (match, ent: string) => {
    switch (ent) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const isHex = ent[1] === "x" || ent[1] === "X";
        const codePoint = parseInt(ent.slice(isHex ? 2 : 1), isHex ? 16 : 10);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
      }
    }
  });
}

export interface DocxExtractResult {
  text: string;
  truncated: boolean;
  paragraphCount: number;
  tableCount: number;
}

/**
 * Extracts visible text from a docx `word/document.xml` part. Text runs
 * live inside `<w:t>...</w:t>` elements (or self-closing `<w:t/>` for
 * empty runs); paragraphs are `<w:p>` elements, tables are `<w:tbl>`
 * elements. Bounded to `maxChars` the same way pdf_extract_text bounds
 * PDF text, for the same reason (keep large payloads out of MCP JSON).
 */
export function extractDocxText(documentXml: string, maxChars: number): DocxExtractResult {
  const paragraphCount = (documentXml.match(/<w:p[ >]/g) ?? []).length;
  const tableCount = (documentXml.match(/<w:tbl[ >]/g) ?? []).length;

  const parts: string[] = [];
  let charCount = 0;
  const textRunPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let match: RegExpExecArray | null;
  while ((match = textRunPattern.exec(documentXml)) !== null) {
    const chunk = unescapeXmlEntities(match[1]);
    parts.push(chunk);
    charCount += chunk.length;
    if (charCount >= maxChars) break;
  }
  // Paragraph breaks: a lightweight join, not a faithful re-rendering of
  // Word's layout — good enough for downstream text analysis.
  let text = parts.join(" ");
  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);
  return { text, truncated, paragraphCount, tableCount };
}

/** `<sheet name="Sheet1" sheetId="1" r:id="rId1"/>` entries from `xl/workbook.xml`. */
export function parseWorkbookSheetNames(workbookXml: string): string[] {
  const names: string[] = [];
  const pattern = /<sheet\s[^>]*\bname="([^"]*)"[^>]*\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(workbookXml)) !== null) {
    names.push(unescapeXmlEntities(match[1]));
  }
  return names;
}

/**
 * `xl/sharedStrings.xml` holds every distinct string used anywhere in the
 * workbook once, referenced by index from cells (`t="s"`). Bounded to
 * `maxEntries` — the explicit defense against a "sharedStrings bomb"
 * (a workbook declaring millions of shared strings) called out in
 * docs/SECURITY.md: this stops us building an unbounded in-memory array
 * regardless of how large the already-size-capped inflated XML is.
 */
export function parseSharedStrings(sharedStringsXml: string, maxEntries: number): { strings: string[]; truncated: boolean } {
  const strings: string[] = [];
  const siPattern = /<si>([\s\S]*?)<\/si>/g;
  let match: RegExpExecArray | null;
  let truncated = false;
  while ((match = siPattern.exec(sharedStringsXml)) !== null) {
    if (strings.length >= maxEntries) {
      truncated = true;
      break;
    }
    const body = match[1];
    const textPattern = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let textMatch: RegExpExecArray | null;
    let combined = "";
    while ((textMatch = textPattern.exec(body)) !== null) combined += unescapeXmlEntities(textMatch[1]);
    strings.push(combined);
  }
  return { strings, truncated };
}

export interface WorksheetPreview {
  rowCount: number;
  columnCount: number;
  headers: string[];
  sampleRows: string[][];
  truncated: boolean;
}

function columnLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1; // 0-indexed
}

/**
 * Bounded preview of one worksheet's rows: exact row/column counts come
 * from the `<dimension ref="A1:D10"/>` element when present (cheap, no
 * full scan needed); otherwise falls back to counting `<row` elements up
 * to `maxRowsScanned`. Only the first `maxSampleRows` rows are actually
 * materialized as cell values — this is a preview, not a full-sheet dump
 * (mirrors pdf_extract_text's page-bounded philosophy for the same "don't
 * blow up MCP JSON with an entire document" reason).
 */
export function parseWorksheetPreview(
  sheetXml: string,
  sharedStrings: string[],
  options: { maxSampleRows: number; maxRowsScanned: number; maxCellChars: number },
): WorksheetPreview {
  const dimensionMatch = sheetXml.match(/<dimension\s+ref="([A-Z]+)\d+:([A-Z]+)(\d+)"/);
  let declaredColumnCount = 0;
  let declaredRowCount = 0;
  if (dimensionMatch) {
    declaredColumnCount = columnLettersToIndex(dimensionMatch[2]) + 1;
    declaredRowCount = Number(dimensionMatch[3]);
  }

  const sampleRows: string[][] = [];
  let scannedRows = 0;
  let maxColumnSeen = 0;
  let truncated = false;
  const rowPattern = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowPattern.exec(sheetXml)) !== null) {
    scannedRows++;
    if (scannedRows > options.maxRowsScanned) {
      truncated = true;
      break;
    }
    if (sampleRows.length < options.maxSampleRows) {
      const cells: string[] = [];
      const cellPattern = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) {
        const attrs = cellMatch[1] ?? cellMatch[3] ?? "";
        const body = cellMatch[2] ?? "";
        const refMatch = attrs.match(/\br="([A-Z]+)\d+"/);
        if (refMatch) maxColumnSeen = Math.max(maxColumnSeen, columnLettersToIndex(refMatch[1]) + 1);
        const typeMatch = attrs.match(/\bt="([a-zA-Z]+)"/);
        const cellType = typeMatch?.[1];
        let value = "";
        if (cellType === "s") {
          const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
          const idx = vMatch ? Number(vMatch[1]) : NaN;
          value = Number.isInteger(idx) ? (sharedStrings[idx] ?? "") : "";
        } else if (cellType === "inlineStr") {
          const tMatch = body.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/);
          value = tMatch ? unescapeXmlEntities(tMatch[1]) : "";
        } else {
          const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
          value = vMatch ? unescapeXmlEntities(vMatch[1]) : "";
        }
        if (value.length > options.maxCellChars) value = value.slice(0, options.maxCellChars);
        cells.push(value);
      }
      sampleRows.push(cells);
    }
  }

  return {
    rowCount: declaredRowCount || scannedRows,
    columnCount: declaredColumnCount || maxColumnSeen,
    headers: sampleRows[0] ?? [],
    sampleRows,
    truncated: truncated || scannedRows > options.maxSampleRows,
  };
}
