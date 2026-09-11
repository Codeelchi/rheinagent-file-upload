import fs from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { MimeCategory } from "./security.js";
import { readZipEntries } from "./officeZip.js";
import { extractDocxText, parseWorkbookSheetNames, parseSharedStrings, parseWorksheetPreview } from "./officeXml.js";

/**
 * Server-side processor registry. There is no generic "run a command" or
 * "execute this code" tool anywhere in this product — a processor is a
 * fixed, named TypeScript function registered here at build time. Adding
 * capability means adding a registry entry and shipping a new release, not
 * accepting arbitrary code/shell input from an MCP client.
 */

export interface ProcessorContext {
  filePath: string;
  filename: string;
  mimeCategory: string;
  /** Opaque, per-processor options from rheinagent_file_process_prepare's
   * `options` input — most processors ignore this entirely. A processor
   * that reads it is responsible for validating shape/range itself and
   * throwing a clear error for anything it doesn't understand (the same
   * pattern already used for the mimeCategory guard below). */
  options?: Record<string, unknown>;
}

export type Processor = (ctx: ProcessorContext) => Promise<Record<string, unknown>>;

interface ProcessorEntry {
  supportedMimeCategories: readonly MimeCategory[];
  run: Processor;
}

const registry = new Map<string, ProcessorEntry>();

function register(id: string, supportedMimeCategories: readonly MimeCategory[], run: Processor): void {
  registry.set(id, { supportedMimeCategories, run });
}

export function getProcessor(id: string): Processor | undefined {
  return registry.get(id)?.run;
}

/**
 * Whether `id` declares support for `category` — checked by
 * rheinagent_file_process_prepare (server.ts) *before* a job is created, so
 * a mismatched processor_id/file pairing (e.g. text_stats against a PDF)
 * is rejected immediately instead of only failing later inside
 * process_apply after a job already went through its prepared→failed
 * lifecycle. The per-processor runtime check below stays too, as defense
 * in depth against a registry entry ever declaring the wrong category.
 */
export function processorSupportsMimeCategory(id: string, category: MimeCategory): boolean {
  return registry.get(id)?.supportedMimeCategories.includes(category) ?? false;
}

export function listProcessorIds(): string[] {
  return [...registry.keys()];
}

/** Same as listProcessorIds() but with each processor's supported
 * categories attached — lets a client (or capabilities_get) tell which
 * processor_id is even valid for a given file without trial and error. */
export function listProcessorsWithCategories(): { id: string; supported_mime_categories: MimeCategory[] }[] {
  return [...registry.entries()].map(([id, entry]) => ({
    id,
    supported_mime_categories: [...entry.supportedMimeCategories],
  }));
}

register("text_stats", ["text"], async (ctx) => {
  if (ctx.mimeCategory !== "text") {
    throw new Error("text_stats only supports text documents");
  }
  const content = await fs.readFile(ctx.filePath, "utf-8");
  const lines = content.split(/\r?\n/);
  const words = content.split(/\s+/).filter(Boolean);
  return {
    line_count: lines.length,
    word_count: words.length,
    char_count: content.length,
  };
});

register("text_uppercase", ["text"], async (ctx) => {
  if (ctx.mimeCategory !== "text") {
    throw new Error("text_uppercase only supports text documents");
  }
  const content = await fs.readFile(ctx.filePath, "utf-8");
  return { transformed_text: content.toUpperCase() };
});

/**
 * Hand-rolled PNG/JPEG dimension parsing — deliberately no image library
 * dependency (no sharp/jimp: native or heavy, unnecessary for just reading
 * a header). Mirrors this project's existing style of parsing binary
 * formats by hand for a narrow, well-understood purpose (see
 * sniffMimeCategory() in security.ts). Only PNG and JPEG are reachable at
 * all — EXTENSION_ALLOWLIST in security.ts only accepts .png/.jpg/.jpeg
 * under mime_category "image".
 */
function parsePngDimensions(buf: Buffer): { width: number; height: number } {
  // PNG spec: an 8-byte signature, then the IHDR chunk MUST be first —
  // width/height are always at these fixed offsets, big-endian.
  if (buf.length < 24) throw new Error("PNG too short to contain an IHDR chunk");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function parseJpegDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new Error("not a JPEG (missing SOI marker)");
  }
  let offset = 2;
  while (offset + 1 < buf.length) {
    if (buf[offset] !== 0xff) throw new Error("malformed JPEG: expected marker byte");
    let marker = buf[offset + 1];
    offset += 2;
    while (marker === 0xff && offset < buf.length) marker = buf[offset++]; // skip fill bytes
    if (marker === 0xd9 /* EOI */) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue; // TEM/RSTn/SOI: no payload
    if (offset + 2 > buf.length) break;
    const segmentLength = buf.readUInt16BE(offset);
    // SOF0–SOF15 except DHT(C4)/JPG(C8)/DAC(CC), which share the C0–CF range but aren't frame headers.
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      if (offset + 7 > buf.length) throw new Error("truncated JPEG SOF segment");
      return { height: buf.readUInt16BE(offset + 3), width: buf.readUInt16BE(offset + 5) };
    }
    offset += segmentLength;
  }
  throw new Error("no SOF (frame header) marker found in JPEG");
}

register("image_metadata", ["image"], async (ctx) => {
  if (ctx.mimeCategory !== "image") {
    throw new Error("image_metadata only supports image documents");
  }
  const buf = await fs.readFile(ctx.filePath);
  const isPng = buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const { width, height } = isPng ? parsePngDimensions(buf) : parseJpegDimensions(buf);
  return { format: isPng ? "png" : "jpeg", width, height, size_bytes: buf.length };
});

/**
 * PDF text extraction/metadata via `pdfjs-dist` (Mozilla's own PDF.js core,
 * zero runtime dependencies of its own — deliberately NOT the popular
 * `pdf-parse` wrapper, which pulls in `@napi-rs/canvas`, a native binary
 * addon unnecessary for pure text extraction and unwelcome on an arm64
 * on-prem box). Runs with `disableWorker: true`: this is a short-lived,
 * one-shot per-job extraction inside an already-async tool handler, not a
 * browser tab — spinning up a worker_threads worker just to immediately
 * tear it down again buys nothing here.
 */
const PDFJS_PACKAGE_DIR = path.dirname(new URL(import.meta.resolve("pdfjs-dist/package.json")).pathname);
const PDFJS_STANDARD_FONT_DATA_URL = path.join(PDFJS_PACKAGE_DIR, "standard_fonts") + "/";
const PDFJS_CMAP_URL = path.join(PDFJS_PACKAGE_DIR, "cmaps") + "/";

// Extracted text flows back to the client as tool structuredContent (MCP
// JSON), same reasoning as INLINE_CONTENT_MAX_BYTES in server.ts for small
// text files: keep large payloads out of MCP JSON rather than dumping an
// entire book-length PDF into one tool result.
const PDF_TEXT_MAX_CHARS = 64 * 1024;

async function loadPdfDocument(filePath: string) {
  const buf = await fs.readFile(filePath);
  const loadingTask = getDocument({
    data: new Uint8Array(buf),
    // No `workerSrc`/`workerPort` configured, and none needed: pdf.js
    // detects it's running under Node (no `Worker` global available the
    // way a browser/worker_threads-registered one would be) and falls
    // back to synchronous main-thread parsing on its own.
    isEvalSupported: false,
    standardFontDataUrl: PDFJS_STANDARD_FONT_DATA_URL,
    cMapUrl: PDFJS_CMAP_URL,
    cMapPacked: true,
  });
  return loadingTask.promise;
}

function pdfInfoString(info: unknown, key: string): string | null {
  if (typeof info !== "object" || info === null) return null;
  const value = (info as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pdfTextItemString(item: unknown): string {
  if (typeof item !== "object" || item === null || !("str" in item)) return "";
  const str = (item as { str: unknown }).str;
  return typeof str === "string" ? str : "";
}

register("pdf_metadata", ["pdf"], async (ctx) => {
  if (ctx.mimeCategory !== "pdf") {
    throw new Error("pdf_metadata only supports PDF documents");
  }
  const doc = await loadPdfDocument(ctx.filePath);
  try {
    const meta = await doc.getMetadata().catch(() => undefined);
    return {
      page_count: doc.numPages,
      pdf_format_version: pdfInfoString(meta?.info, "PDFFormatVersion"),
      title: pdfInfoString(meta?.info, "Title"),
      author: pdfInfoString(meta?.info, "Author"),
    };
  } finally {
    await doc.destroy();
  }
});

/**
 * Reads `options.page` (1-indexed) if present — lets a caller pull one
 * specific page out of a PDF too long to fit under PDF_TEXT_MAX_CHARS as a
 * whole, instead of only ever getting the first ~64 KiB of it. Returns
 * `undefined` when no page option was given (full-document extraction,
 * the original behavior); throws for a present-but-invalid value so a
 * caller's mistake is a clear job failure, not a silent fallback to
 * "extract everything" or to page 1.
 */
function parsePageOption(options: Record<string, unknown> | undefined): number | undefined {
  if (!options || !("page" in options)) return undefined;
  const page = options.page;
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1) {
    throw new Error(`options.page must be a positive integer, got ${JSON.stringify(page)}`);
  }
  return page;
}

/** Throws a clear job error if `ctx.filename` doesn't have `ext` — used by
 * processors registered for a coarse mime_category ("text"/"office") that
 * actually only make sense for one specific extension within it (e.g.
 * csv_inspect only makes sense for .csv, not every "text" file). */
function requireExtension(ctx: ProcessorContext, ext: string): void {
  if (!ctx.filename.toLowerCase().endsWith(ext)) {
    throw new Error(`${ext.slice(1)}_inspect requires a "${ext}" file, got "${ctx.filename}"`);
  }
}

const TEXT_EXTRACT_MAX_CHARS = 64 * 1024;

register("text_extract", ["text"], async (ctx) => {
  const content = await fs.readFile(ctx.filePath, "utf-8");
  const truncated = content.length > TEXT_EXTRACT_MAX_CHARS;
  return {
    text: truncated ? content.slice(0, TEXT_EXTRACT_MAX_CHARS) : content,
    char_count: content.length,
    word_count: content.split(/\s+/).filter(Boolean).length,
    line_count: content.split(/\r?\n/).length,
    truncated,
  };
});

register("markdown_structure", ["text"], async (ctx) => {
  requireExtension(ctx, ".md");
  const content = await fs.readFile(ctx.filePath, "utf-8");
  const headings = [...content.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((m) => ({ level: m[1].length, text: m[2].trim() }));
  const linksCount = (content.match(/\[[^\]]*\]\([^)]*\)/g) ?? []).length;
  const codeBlockCount = (content.match(/^```/gm) ?? []).length / 2;
  return { headings, links_count: linksCount, code_block_count: Math.floor(codeBlockCount) };
});

/**
 * Hand-rolled CSV tokenizer (RFC 4180-ish: quoted fields, `""` escaping,
 * embedded delimiters/newlines inside quotes). Stops after `maxRows`
 * regardless of how much of the file remains — protection against "very
 * many CSV rows" within the already-enforced upload size limit, per
 * docs/SECURITY.md's format-specific test list.
 */
function parseCsv(content: string, delimiter: string, maxRows: number): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  let truncated = false;
  while (i < content.length) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
      i++;
    } else if (ch === "\r") {
      i++; // consumed, \n (if present) ends the row below
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  if (!truncated && (field.length > 0 || row.length > 0)) {
    row.push(field);
    rows.push(row);
  }
  return { rows, truncated };
}

function detectCsvDelimiter(firstLine: string): string {
  const candidates = [",", ";", "\t"];
  let best = ",";
  let bestCount = -1;
  for (const c of candidates) {
    const count = firstLine.split(c).length - 1;
    if (count > bestCount) {
      best = c;
      bestCount = count;
    }
  }
  return best;
}

const CSV_MAX_ROWS_SCANNED = 5000;
const CSV_MAX_SAMPLE_ROWS = 20;
const CSV_MAX_CELL_CHARS = 500;

function parseDelimiterOption(options: Record<string, unknown> | undefined): string | undefined {
  if (!options || !("delimiter" in options)) return undefined;
  const d = options.delimiter;
  if (typeof d !== "string" || d.length !== 1) {
    throw new Error(`options.delimiter must be a single character, got ${JSON.stringify(d)}`);
  }
  return d;
}

register("csv_inspect", ["text"], async (ctx) => {
  requireExtension(ctx, ".csv");
  const content = await fs.readFile(ctx.filePath, "utf-8");
  const firstLine = content.slice(0, content.indexOf("\n") === -1 ? content.length : content.indexOf("\n"));
  const delimiter = parseDelimiterOption(ctx.options) ?? detectCsvDelimiter(firstLine);
  const { rows, truncated } = parseCsv(content, delimiter, CSV_MAX_ROWS_SCANNED);
  const capped = rows.map((r) => r.map((cell) => (cell.length > CSV_MAX_CELL_CHARS ? cell.slice(0, CSV_MAX_CELL_CHARS) : cell)));
  return {
    delimiter,
    row_count: capped.length,
    column_count: capped[0]?.length ?? 0,
    headers: capped[0] ?? [],
    sample_rows: capped.slice(1, 1 + CSV_MAX_SAMPLE_ROWS),
    truncated,
  };
});

const JSON_MAX_DEPTH = 64;
const JSON_MAX_SAMPLE_KEYS = 50;

/** Bracket-depth pre-scan over the raw text, *before* calling JSON.parse —
 * JSON.parse's own recursive descent is what could stack-overflow on
 * absurdly deep input, so this rejects anything beyond JSON_MAX_DEPTH
 * without ever handing that input to the real parser. A simple linear
 * scan, not a real tokenizer: it ignores bracket characters that appear
 * inside string literals by tracking quote state, which is enough to be
 * a safe (if slightly conservative) upper bound on real nesting depth. */
function assertJsonDepthWithinLimit(content: string, maxDepth: number): void {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of content) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") {
      depth++;
      if (depth > maxDepth) throw new Error(`JSON nesting depth exceeds the ${maxDepth}-level limit`);
    } else if (ch === "}" || ch === "]") depth--;
  }
}

register("json_inspect", ["text"], async (ctx) => {
  requireExtension(ctx, ".json");
  const content = await fs.readFile(ctx.filePath, "utf-8");
  assertJsonDepthWithinLimit(content, JSON_MAX_DEPTH);
  const parsed: unknown = JSON.parse(content);
  const rootType = Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed;
  const arrayLength = Array.isArray(parsed) ? parsed.length : null;
  const keys =
    rootType === "object" && parsed !== null
      ? Object.keys(parsed as Record<string, unknown>).slice(0, JSON_MAX_SAMPLE_KEYS)
      : null;
  const keysTruncated = rootType === "object" && parsed !== null ? Object.keys(parsed as Record<string, unknown>).length > JSON_MAX_SAMPLE_KEYS : false;
  const rawSample = Array.isArray(parsed) ? parsed.slice(0, 5) : parsed;
  const sampleJson = JSON.stringify(rawSample) ?? "null";
  const sampleTruncated = sampleJson.length > TEXT_EXTRACT_MAX_CHARS;
  return {
    root_type: rootType,
    array_length: arrayLength,
    keys,
    keys_truncated: keysTruncated,
    sample: sampleTruncated ? sampleJson.slice(0, TEXT_EXTRACT_MAX_CHARS) : rawSample,
    sample_truncated: sampleTruncated,
  };
});

const DOCX_TEXT_MAX_CHARS = 64 * 1024;
const OFFICE_ZIP_MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const OFFICE_ZIP_MAX_TOTAL_BYTES = 40 * 1024 * 1024;

register("docx_extract_text", ["office"], async (ctx) => {
  requireExtension(ctx, ".docx");
  const buf = await fs.readFile(ctx.filePath);
  const entries = readZipEntries(buf, {
    wantedNames: new Set(["word/document.xml"]),
    maxEntryInflatedBytes: OFFICE_ZIP_MAX_ENTRY_BYTES,
    maxTotalInflatedBytes: OFFICE_ZIP_MAX_TOTAL_BYTES,
  });
  const documentXml = entries.get("word/document.xml");
  if (!documentXml) throw new Error("docx is missing word/document.xml — not a valid Word document");
  const result = extractDocxText(documentXml.toString("utf-8"), DOCX_TEXT_MAX_CHARS);
  return {
    text: result.text,
    paragraph_count: result.paragraphCount,
    table_count: result.tableCount,
    truncated: result.truncated,
  };
});

const XLSX_MAX_SHARED_STRINGS = 20000;
const XLSX_MAX_SAMPLE_ROWS = 20;
const XLSX_MAX_ROWS_SCANNED = 5000;
const XLSX_MAX_CELL_CHARS = 500;

function parseSheetOption(options: Record<string, unknown> | undefined): string | undefined {
  if (!options || !("sheet" in options)) return undefined;
  const sheet = options.sheet;
  if (typeof sheet !== "string" || sheet.length === 0) {
    throw new Error(`options.sheet must be a non-empty string, got ${JSON.stringify(sheet)}`);
  }
  return sheet;
}

register("xlsx_inspect", ["office"], async (ctx) => {
  requireExtension(ctx, ".xlsx");
  const requestedSheet = parseSheetOption(ctx.options);
  const buf = await fs.readFile(ctx.filePath);
  const workbookEntries = readZipEntries(buf, {
    wantedNames: new Set(["xl/workbook.xml"]),
    maxEntryInflatedBytes: OFFICE_ZIP_MAX_ENTRY_BYTES,
    maxTotalInflatedBytes: OFFICE_ZIP_MAX_TOTAL_BYTES,
  });
  const workbookXml = workbookEntries.get("xl/workbook.xml");
  if (!workbookXml) throw new Error("xlsx is missing xl/workbook.xml — not a valid Excel workbook");
  const sheetNames = parseWorkbookSheetNames(workbookXml.toString("utf-8"));
  if (sheetNames.length === 0) throw new Error("xlsx declares no worksheets");
  const sheetIndex = requestedSheet ? sheetNames.indexOf(requestedSheet) : 0;
  if (sheetIndex === -1) {
    throw new Error(`options.sheet "${requestedSheet}" not found — available sheets: ${sheetNames.join(", ")}`);
  }
  const sheetEntryName = `xl/worksheets/sheet${sheetIndex + 1}.xml`;

  const dataEntries = readZipEntries(buf, {
    wantedNames: new Set(["xl/sharedStrings.xml", sheetEntryName]),
    maxEntryInflatedBytes: OFFICE_ZIP_MAX_ENTRY_BYTES,
    maxTotalInflatedBytes: OFFICE_ZIP_MAX_TOTAL_BYTES,
  });
  const sharedStringsXml = dataEntries.get("xl/sharedStrings.xml")?.toString("utf-8");
  const shared = sharedStringsXml ? parseSharedStrings(sharedStringsXml, XLSX_MAX_SHARED_STRINGS) : { strings: [], truncated: false };
  const sheetXml = dataEntries.get(sheetEntryName);
  if (!sheetXml) throw new Error(`xlsx is missing ${sheetEntryName} for sheet "${sheetNames[sheetIndex]}"`);
  const preview = parseWorksheetPreview(sheetXml.toString("utf-8"), shared.strings, {
    maxSampleRows: XLSX_MAX_SAMPLE_ROWS,
    maxRowsScanned: XLSX_MAX_ROWS_SCANNED,
    maxCellChars: XLSX_MAX_CELL_CHARS,
  });
  return {
    sheet_names: sheetNames,
    sheet: sheetNames[sheetIndex],
    row_count: preview.rowCount,
    column_count: preview.columnCount,
    headers: preview.headers,
    sample_rows: preview.sampleRows,
    shared_strings_truncated: shared.truncated,
    truncated: preview.truncated,
  };
});

register("pdf_extract_text", ["pdf"], async (ctx) => {
  if (ctx.mimeCategory !== "pdf") {
    throw new Error("pdf_extract_text only supports PDF documents");
  }
  const requestedPage = parsePageOption(ctx.options);
  const doc = await loadPdfDocument(ctx.filePath);
  try {
    if (requestedPage !== undefined && requestedPage > doc.numPages) {
      throw new Error(`options.page ${requestedPage} is out of range — this PDF has ${doc.numPages} page(s)`);
    }
    const firstPage = requestedPage ?? 1;
    const lastPage = requestedPage ?? doc.numPages;

    const pageTexts: string[] = [];
    let charCount = 0;
    for (let pageNum = firstPage; pageNum <= lastPage; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      const pageText = content.items.map(pdfTextItemString).join(" ");
      pageTexts.push(pageText);
      charCount += pageText.length;
      if (charCount >= PDF_TEXT_MAX_CHARS) break;
    }
    let extractedText = pageTexts.join("\n\n");
    const truncated = extractedText.length > PDF_TEXT_MAX_CHARS;
    if (truncated) extractedText = extractedText.slice(0, PDF_TEXT_MAX_CHARS);
    return {
      extracted_text: extractedText,
      page_count: doc.numPages,
      page: requestedPage ?? null,
      truncated,
    };
  } finally {
    await doc.destroy();
  }
});
