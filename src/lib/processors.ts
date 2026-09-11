import fs from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { MimeCategory } from "./security.js";

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

register("pdf_extract_text", ["pdf"], async (ctx) => {
  if (ctx.mimeCategory !== "pdf") {
    throw new Error("pdf_extract_text only supports PDF documents");
  }
  const doc = await loadPdfDocument(ctx.filePath);
  try {
    const pageTexts: string[] = [];
    let charCount = 0;
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
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
    return { extracted_text: extractedText, page_count: doc.numPages, truncated };
  } finally {
    await doc.destroy();
  }
});
