import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  getProcessor,
  processorSupportsMimeCategory,
  listProcessorIds,
  listProcessorsWithCategories,
} from "../src/lib/processors.js";
import { buildSampleDocx, buildSampleXlsx, buildZip } from "./testZip.js";

// --- registry / mime-category declarations ---

test("listProcessorIds includes every registered processor", () => {
  const ids = listProcessorIds();
  for (const id of [
    "text_stats",
    "text_uppercase",
    "text_extract",
    "markdown_structure",
    "csv_inspect",
    "json_inspect",
    "docx_extract_text",
    "xlsx_inspect",
    "image_metadata",
    "pdf_metadata",
    "pdf_extract_text",
  ]) {
    assert.ok(ids.includes(id), `expected ${id} to be registered`);
  }
});

test("processorSupportsMimeCategory matches each processor's declared category, nothing else", () => {
  assert.equal(processorSupportsMimeCategory("text_stats", "text"), true);
  assert.equal(processorSupportsMimeCategory("text_stats", "pdf"), false);
  assert.equal(processorSupportsMimeCategory("image_metadata", "image"), true);
  assert.equal(processorSupportsMimeCategory("image_metadata", "text"), false);
  assert.equal(processorSupportsMimeCategory("pdf_metadata", "pdf"), true);
  assert.equal(processorSupportsMimeCategory("pdf_extract_text", "pdf"), true);
  assert.equal(processorSupportsMimeCategory("pdf_extract_text", "image"), false);
});

test("processorSupportsMimeCategory returns false for an unknown processor_id", () => {
  assert.equal(processorSupportsMimeCategory("does_not_exist", "text"), false);
});

test("listProcessorsWithCategories exposes id + supported_mime_categories for every processor", () => {
  const withCategories = listProcessorsWithCategories();
  const textStats = withCategories.find((p) => p.id === "text_stats");
  assert.deepEqual(textStats?.supported_mime_categories, ["text"]);
});

// --- image_metadata: hand-rolled PNG/JPEG dimension parsing ---

function makeMinimalPng(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  function chunk(tag: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const tagBuf = Buffer.from(tag, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([tagBuf, data])) >>> 0);
    return Buffer.concat([len, tagBuf, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height); // all-zero (black) rows, filter byte 0
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function makeMinimalJpeg(width: number, height: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  // SOF0 (baseline), 1 component (grayscale), 8-bit precision
  const sof0 = Buffer.concat([
    Buffer.from([0xff, 0xc0]),
    (() => {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(11);
      return b;
    })(),
    Buffer.from([8]),
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt16BE(height, 0);
      b.writeUInt16BE(width, 2);
      return b;
    })(),
    Buffer.from([1, 1, 0x11, 0]),
  ]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, sof0, eoi]);
}

async function withTempFile(bytes: Buffer, ext: string, fn: (filePath: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raf-processor-test-"));
  const filePath = path.join(dir, `sample${ext}`);
  await fs.writeFile(filePath, bytes);
  try {
    await fn(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("image_metadata reports correct width/height/format for a PNG", async () => {
  await withTempFile(makeMinimalPng(64, 32), ".png", async (filePath) => {
    const run = getProcessor("image_metadata")!;
    const result = await run({ filePath, filename: "sample.png", mimeCategory: "image" });
    assert.deepEqual(result, { format: "png", width: 64, height: 32, size_bytes: (await fs.stat(filePath)).size });
  });
});

test("image_metadata reports correct width/height/format for a JPEG", async () => {
  await withTempFile(makeMinimalJpeg(100, 50), ".jpg", async (filePath) => {
    const run = getProcessor("image_metadata")!;
    const result = await run({ filePath, filename: "sample.jpg", mimeCategory: "image" });
    assert.deepEqual(result, { format: "jpeg", width: 100, height: 50, size_bytes: (await fs.stat(filePath)).size });
  });
});

test("image_metadata rejects a non-image mimeCategory even with image bytes", async () => {
  await withTempFile(makeMinimalPng(1, 1), ".png", async (filePath) => {
    const run = getProcessor("image_metadata")!;
    await assert.rejects(() => run({ filePath, filename: "sample.png", mimeCategory: "text" }), /only supports image/);
  });
});

// --- pdf_metadata / pdf_extract_text ---

const MINIMAL_PDF = Buffer.from(
  `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 200 100] /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length 40 >>
stream
BT /F1 18 Tf 10 50 Td (Hello Test PDF) Tj ET
endstream
endobj
xref
0 6
0000000000 65535 f
trailer
<< /Size 6 /Root 1 0 R >>
startxref
0
%%EOF`,
  "utf-8",
);

test("pdf_extract_text extracts the actual text content of a PDF", async () => {
  await withTempFile(MINIMAL_PDF, ".pdf", async (filePath) => {
    const run = getProcessor("pdf_extract_text")!;
    const result = await run({ filePath, filename: "sample.pdf", mimeCategory: "pdf" });
    assert.equal(result.page_count, 1);
    assert.equal(result.page, null, "no options.page given -> page is null, not omitted");
    assert.equal(result.truncated, false);
    assert.match(result.extracted_text as string, /Hello Test PDF/);
  });
});

test("pdf_extract_text honors options.page to extract a single page", async () => {
  await withTempFile(MINIMAL_PDF, ".pdf", async (filePath) => {
    const run = getProcessor("pdf_extract_text")!;
    const result = await run({ filePath, filename: "sample.pdf", mimeCategory: "pdf", options: { page: 1 } });
    assert.equal(result.page, 1);
    assert.equal(result.page_count, 1);
    assert.match(result.extracted_text as string, /Hello Test PDF/);
  });
});

test("pdf_extract_text rejects an out-of-range options.page", async () => {
  await withTempFile(MINIMAL_PDF, ".pdf", async (filePath) => {
    const run = getProcessor("pdf_extract_text")!;
    await assert.rejects(
      () => run({ filePath, filename: "sample.pdf", mimeCategory: "pdf", options: { page: 2 } }),
      /out of range/,
    );
  });
});

test("pdf_extract_text rejects a malformed options.page", async () => {
  await withTempFile(MINIMAL_PDF, ".pdf", async (filePath) => {
    const run = getProcessor("pdf_extract_text")!;
    await assert.rejects(
      () => run({ filePath, filename: "sample.pdf", mimeCategory: "pdf", options: { page: "one" } }),
      /positive integer/,
    );
    await assert.rejects(
      () => run({ filePath, filename: "sample.pdf", mimeCategory: "pdf", options: { page: 0 } }),
      /positive integer/,
    );
  });
});

test("pdf_metadata reports page_count and pdf_format_version", async () => {
  await withTempFile(MINIMAL_PDF, ".pdf", async (filePath) => {
    const run = getProcessor("pdf_metadata")!;
    const result = await run({ filePath, filename: "sample.pdf", mimeCategory: "pdf" });
    assert.equal(result.page_count, 1);
    assert.equal(result.pdf_format_version, "1.4");
  });
});

test("pdf_extract_text/pdf_metadata reject a non-pdf mimeCategory", async () => {
  await withTempFile(MINIMAL_PDF, ".pdf", async (filePath) => {
    const extract = getProcessor("pdf_extract_text")!;
    const meta = getProcessor("pdf_metadata")!;
    await assert.rejects(() => extract({ filePath, filename: "sample.pdf", mimeCategory: "text" }), /only supports PDF/);
    await assert.rejects(() => meta({ filePath, filename: "sample.pdf", mimeCategory: "text" }), /only supports PDF/);
  });
});

// --- text_extract / markdown_structure ---

test("text_extract returns bounded text plus char/word/line counts", async () => {
  await withTempFile(Buffer.from("hello world\nsecond line\n"), ".txt", async (filePath) => {
    const run = getProcessor("text_extract")!;
    const result = await run({ filePath, filename: "sample.txt", mimeCategory: "text" });
    assert.equal(result.text, "hello world\nsecond line\n");
    assert.equal(result.word_count, 4);
    assert.equal(result.line_count, 3);
    assert.equal(result.truncated, false);
  });
});

test("text_extract truncates content past its char limit", async () => {
  const big = "x".repeat(70_000);
  await withTempFile(Buffer.from(big), ".txt", async (filePath) => {
    const run = getProcessor("text_extract")!;
    const result = await run({ filePath, filename: "sample.txt", mimeCategory: "text" });
    assert.equal(result.truncated, true);
    assert.equal((result.text as string).length, 64 * 1024);
  });
});

test("markdown_structure extracts headings, links, and code blocks", async () => {
  const md = "# Title\n\nSome [link](http://x) text.\n\n```js\ncode\n```\n\n## Sub\n";
  await withTempFile(Buffer.from(md), ".md", async (filePath) => {
    const run = getProcessor("markdown_structure")!;
    const result = await run({ filePath, filename: "sample.md", mimeCategory: "text" });
    assert.deepEqual(result.headings, [
      { level: 1, text: "Title" },
      { level: 2, text: "Sub" },
    ]);
    assert.equal(result.links_count, 1);
    assert.equal(result.code_block_count, 1);
  });
});

test("markdown_structure rejects a non-.md filename even under the text category", async () => {
  await withTempFile(Buffer.from("# Title"), ".txt", async (filePath) => {
    const run = getProcessor("markdown_structure")!;
    await assert.rejects(() => run({ filePath, filename: "sample.txt", mimeCategory: "text" }), /requires a "\.md" file/);
  });
});

// --- csv_inspect ---

test("csv_inspect parses headers/rows, auto-detects the comma delimiter", async () => {
  const csv = 'name,age,city\nAlice,30,Berlin\nBob,25,"Hamburg, DE"\n';
  await withTempFile(Buffer.from(csv), ".csv", async (filePath) => {
    const run = getProcessor("csv_inspect")!;
    const result = await run({ filePath, filename: "sample.csv", mimeCategory: "text" });
    assert.equal(result.delimiter, ",");
    assert.equal(result.row_count, 3);
    assert.deepEqual(result.headers, ["name", "age", "city"]);
    assert.deepEqual(result.sample_rows, [
      ["Alice", "30", "Berlin"],
      ["Bob", "25", "Hamburg, DE"],
    ]);
    assert.equal(result.truncated, false);
  });
});

test("csv_inspect auto-detects a semicolon delimiter", async () => {
  const csv = "a;b;c\n1;2;3\n";
  await withTempFile(Buffer.from(csv), ".csv", async (filePath) => {
    const run = getProcessor("csv_inspect")!;
    const result = await run({ filePath, filename: "sample.csv", mimeCategory: "text" });
    assert.equal(result.delimiter, ";");
    assert.deepEqual(result.headers, ["a", "b", "c"]);
  });
});

test("csv_inspect honors an explicit options.delimiter override", async () => {
  const csv = "a\tb\tc\n1\t2\t3\n";
  await withTempFile(Buffer.from(csv), ".csv", async (filePath) => {
    const run = getProcessor("csv_inspect")!;
    const result = await run({ filePath, filename: "sample.csv", mimeCategory: "text", options: { delimiter: "\t" } });
    assert.equal(result.delimiter, "\t");
    assert.deepEqual(result.headers, ["a", "b", "c"]);
  });
});

test("csv_inspect rejects a malformed options.delimiter", async () => {
  await withTempFile(Buffer.from("a,b\n1,2\n"), ".csv", async (filePath) => {
    const run = getProcessor("csv_inspect")!;
    await assert.rejects(
      () => run({ filePath, filename: "sample.csv", mimeCategory: "text", options: { delimiter: "not-one-char" } }),
      /single character/,
    );
  });
});

test("csv_inspect caps scanned rows at the hard limit and reports truncated", async () => {
  const rows = Array.from({ length: 6000 }, (_, i) => `${i},x`).join("\n");
  await withTempFile(Buffer.from(`id,val\n${rows}\n`), ".csv", async (filePath) => {
    const run = getProcessor("csv_inspect")!;
    const result = await run({ filePath, filename: "sample.csv", mimeCategory: "text" });
    assert.equal(result.truncated, true);
    assert.equal(result.row_count, 5000);
  });
});

test("csv_inspect rejects a non-.csv filename even under the text category", async () => {
  await withTempFile(Buffer.from("a,b\n1,2\n"), ".txt", async (filePath) => {
    const run = getProcessor("csv_inspect")!;
    await assert.rejects(() => run({ filePath, filename: "sample.txt", mimeCategory: "text" }), /requires a "\.csv" file/);
  });
});

// --- json_inspect ---

test("json_inspect reports root_type/keys for an object", async () => {
  const json = JSON.stringify({ a: 1, b: [1, 2, 3], c: { d: "e" } });
  await withTempFile(Buffer.from(json), ".json", async (filePath) => {
    const run = getProcessor("json_inspect")!;
    const result = await run({ filePath, filename: "sample.json", mimeCategory: "text" });
    assert.equal(result.root_type, "object");
    assert.deepEqual(result.keys, ["a", "b", "c"]);
    assert.equal(result.array_length, null);
    assert.equal(result.keys_truncated, false);
  });
});

test("json_inspect reports array_length for an array root", async () => {
  await withTempFile(Buffer.from(JSON.stringify([1, 2, 3, 4])), ".json", async (filePath) => {
    const run = getProcessor("json_inspect")!;
    const result = await run({ filePath, filename: "sample.json", mimeCategory: "text" });
    assert.equal(result.root_type, "array");
    assert.equal(result.array_length, 4);
  });
});

test("json_inspect caps the reported key list at the sample limit", async () => {
  const obj: Record<string, number> = {};
  for (let i = 0; i < 100; i++) obj[`key${i}`] = i;
  await withTempFile(Buffer.from(JSON.stringify(obj)), ".json", async (filePath) => {
    const run = getProcessor("json_inspect")!;
    const result = await run({ filePath, filename: "sample.json", mimeCategory: "text" });
    assert.equal((result.keys as string[]).length, 50);
    assert.equal(result.keys_truncated, true);
  });
});

test("json_inspect rejects JSON nested deeper than the hard limit, without ever calling JSON.parse", async () => {
  const deep = "[".repeat(1000);
  await withTempFile(Buffer.from(deep), ".json", async (filePath) => {
    const run = getProcessor("json_inspect")!;
    await assert.rejects(() => run({ filePath, filename: "sample.json", mimeCategory: "text" }), /nesting depth exceeds/);
  });
});

test("json_inspect rejects malformed JSON", async () => {
  await withTempFile(Buffer.from("{ not valid json"), ".json", async (filePath) => {
    const run = getProcessor("json_inspect")!;
    await assert.rejects(() => run({ filePath, filename: "sample.json", mimeCategory: "text" }));
  });
});

test("json_inspect rejects a non-.json filename even under the text category", async () => {
  await withTempFile(Buffer.from("{}"), ".txt", async (filePath) => {
    const run = getProcessor("json_inspect")!;
    await assert.rejects(() => run({ filePath, filename: "sample.txt", mimeCategory: "text" }), /requires a "\.json" file/);
  });
});

// --- docx_extract_text ---

test("docx_extract_text extracts text/paragraph/table counts from a real docx-shaped archive", async () => {
  await withTempFile(buildSampleDocx(), ".docx", async (filePath) => {
    const run = getProcessor("docx_extract_text")!;
    const result = await run({ filePath, filename: "sample.docx", mimeCategory: "office" });
    assert.match(result.text as string, /Hello from a test DOCX document/);
    assert.equal(result.paragraph_count, 3);
    assert.equal(result.table_count, 1);
    assert.equal(result.truncated, false);
  });
});

test("docx_extract_text rejects an archive missing word/document.xml", async () => {
  const zip = buildZip([{ name: "[Content_Types].xml", content: Buffer.from("<Types/>") }]);
  await withTempFile(zip, ".docx", async (filePath) => {
    const run = getProcessor("docx_extract_text")!;
    await assert.rejects(() => run({ filePath, filename: "sample.docx", mimeCategory: "office" }), /missing word\/document\.xml/);
  });
});

test("docx_extract_text rejects a zip bomb entry instead of materializing it", async () => {
  const huge = Buffer.alloc(25 * 1024 * 1024, 65); // highly compressible, exceeds the 20 MB per-entry cap
  const zip = buildZip([{ name: "word/document.xml", content: huge }]);
  await withTempFile(zip, ".docx", async (filePath) => {
    const run = getProcessor("docx_extract_text")!;
    await assert.rejects(() => run({ filePath, filename: "sample.docx", mimeCategory: "office" }));
  });
});

test("docx_extract_text rejects a non-.docx filename even under the office category", async () => {
  await withTempFile(buildSampleDocx(), ".xlsx", async (filePath) => {
    const run = getProcessor("docx_extract_text")!;
    await assert.rejects(() => run({ filePath, filename: "sample.xlsx", mimeCategory: "office" }), /requires a "\.docx" file/);
  });
});

// --- xlsx_inspect ---

test("xlsx_inspect resolves shared-string cells into headers/sample_rows for a real xlsx-shaped archive", async () => {
  await withTempFile(buildSampleXlsx(), ".xlsx", async (filePath) => {
    const run = getProcessor("xlsx_inspect")!;
    const result = await run({ filePath, filename: "sample.xlsx", mimeCategory: "office" });
    assert.deepEqual(result.sheet_names, ["Sheet1"]);
    assert.equal(result.sheet, "Sheet1");
    assert.equal(result.row_count, 2);
    assert.deepEqual(result.headers, ["Name", "Age"]);
    assert.deepEqual(result.sample_rows, [
      ["Name", "Age"],
      ["Alice", "30"],
    ]);
  });
});

test("xlsx_inspect rejects an unknown options.sheet, listing the real sheet names", async () => {
  await withTempFile(buildSampleXlsx(), ".xlsx", async (filePath) => {
    const run = getProcessor("xlsx_inspect")!;
    await assert.rejects(
      () => run({ filePath, filename: "sample.xlsx", mimeCategory: "office", options: { sheet: "DoesNotExist" } }),
      /available sheets: Sheet1/,
    );
  });
});

test("xlsx_inspect rejects a non-.xlsx filename even under the office category", async () => {
  await withTempFile(buildSampleXlsx(), ".docx", async (filePath) => {
    const run = getProcessor("xlsx_inspect")!;
    await assert.rejects(() => run({ filePath, filename: "sample.docx", mimeCategory: "office" }), /requires a "\.xlsx" file/);
  });
});
