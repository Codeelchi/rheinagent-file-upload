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

// --- registry / mime-category declarations ---

test("listProcessorIds includes every registered processor", () => {
  const ids = listProcessorIds();
  for (const id of ["text_stats", "text_uppercase", "image_metadata", "pdf_metadata", "pdf_extract_text"]) {
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
    assert.equal(result.truncated, false);
    assert.match(result.extracted_text as string, /Hello Test PDF/);
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
