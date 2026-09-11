import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDocxText, parseWorkbookSheetNames, parseSharedStrings, parseWorksheetPreview } from "../src/lib/officeXml.js";
import { sampleDocxDocumentXml } from "./testZip.js";

// Narrow OOXML text extraction (no general XML parser, see officeXml.ts docstring).

test("extractDocxText pulls text out of <w:t> runs, unescapes entities, counts paragraphs/tables", () => {
  const result = extractDocxText(sampleDocxDocumentXml().toString("utf-8"), 10_000);
  assert.equal(result.text, "Hello from a test DOCX document. Second paragraph with & an ampersand. Cell A1");
  assert.equal(result.paragraphCount, 3);
  assert.equal(result.tableCount, 1);
  assert.equal(result.truncated, false);
});

test("extractDocxText truncates at maxChars and sets truncated", () => {
  const result = extractDocxText(sampleDocxDocumentXml().toString("utf-8"), 10);
  assert.equal(result.text.length, 10);
  assert.equal(result.truncated, true);
});

test("extractDocxText ignores markup outside <w:t>, no XXE/entity expansion beyond the five predefined + numeric refs", () => {
  const xml = `<w:document><w:body><w:p><w:r><w:t>Plain &amp; safe &#65; text</w:t></w:r></w:p></w:body></w:document>`;
  const result = extractDocxText(xml, 1000);
  assert.equal(result.text, "Plain & safe A text");
});

test("parseWorkbookSheetNames extracts every <sheet name=.../> in order", () => {
  const xml = `<workbook><sheets><sheet name="First" sheetId="1"/><sheet name="Second Sheet" sheetId="2"/></sheets></workbook>`;
  assert.deepEqual(parseWorkbookSheetNames(xml), ["First", "Second Sheet"]);
});

test("parseSharedStrings concatenates multi-run <si> entries and respects maxEntries", () => {
  const xml = `<sst><si><t>solo</t></si><si><r><t>multi</t></r><r><t>-run</t></r></si><si><t>third</t></si></sst>`;
  const result = parseSharedStrings(xml, 2);
  assert.deepEqual(result.strings, ["solo", "multi-run"]);
  assert.equal(result.truncated, true);
});

test("parseSharedStrings is not truncated when entry count is within the limit", () => {
  const xml = `<sst><si><t>a</t></si><si><t>b</t></si></sst>`;
  const result = parseSharedStrings(xml, 10);
  assert.deepEqual(result.strings, ["a", "b"]);
  assert.equal(result.truncated, false);
});

test("parseWorksheetPreview reads dimension for exact row/column count and resolves shared-string cells", () => {
  const shared = ["Name", "Age", "Alice"];
  const xml = `<worksheet><dimension ref="A1:B2"/><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>30</v></c></row>
  </sheetData></worksheet>`;
  const preview = parseWorksheetPreview(xml, shared, { maxSampleRows: 20, maxRowsScanned: 100, maxCellChars: 500 });
  assert.equal(preview.rowCount, 2);
  assert.equal(preview.columnCount, 2);
  assert.deepEqual(preview.headers, ["Name", "Age"]);
  assert.deepEqual(preview.sampleRows, [["Name", "Age"], ["Alice", "30"]]);
  assert.equal(preview.truncated, false);
});

test("parseWorksheetPreview falls back to counting <row> elements when no <dimension> is present", () => {
  const xml = `<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A1"><v>2</v></c></row></sheetData></worksheet>`;
  const preview = parseWorksheetPreview(xml, [], { maxSampleRows: 20, maxRowsScanned: 100, maxCellChars: 500 });
  assert.equal(preview.rowCount, 2);
});

test("parseWorksheetPreview stops scanning at maxRowsScanned and reports truncated", () => {
  const rows = Array.from({ length: 50 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join("");
  const xml = `<worksheet><sheetData>${rows}</sheetData></worksheet>`;
  const preview = parseWorksheetPreview(xml, [], { maxSampleRows: 5, maxRowsScanned: 10, maxCellChars: 500 });
  assert.equal(preview.truncated, true);
  assert.equal(preview.sampleRows.length, 5);
});

test("parseWorksheetPreview truncates an individual cell value at maxCellChars", () => {
  const long = "x".repeat(1000);
  const xml = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${long}</t></is></c></row></sheetData></worksheet>`;
  const preview = parseWorksheetPreview(xml, [], { maxSampleRows: 5, maxRowsScanned: 10, maxCellChars: 100 });
  assert.equal(preview.sampleRows[0][0].length, 100);
});
