import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  classifyExtension,
  sniffMimeCategory,
  safeJoin,
  sha256Hex,
} from "../src/lib/security.js";
import { assertOpaqueId, newFileId, newUploadId } from "../src/lib/ids.js";

// --- opaque id enforcement: path traversal must be rejected before any fs path is built ---

test("assertOpaqueId rejects path traversal strings", () => {
  for (const bad of ["../../etc/passwd", "..", "foo/../bar", "/etc/passwd", "file_", "not-an-id"]) {
    assert.throws(() => assertOpaqueId(bad), /invalid opaque id/, `expected rejection for: ${bad}`);
  }
});

test("assertOpaqueId accepts our own generated ids", () => {
  assert.doesNotThrow(() => assertOpaqueId(newFileId()));
  assert.doesNotThrow(() => assertOpaqueId(newUploadId()));
});

// --- extension allowlist ---

test("classifyExtension rejects archive extensions outright", () => {
  assert.equal(classifyExtension("bomb.zip"), null);
  assert.equal(classifyExtension("archive.tar"), null);
});

test("classifyExtension rejects unknown/unlisted extensions", () => {
  assert.equal(classifyExtension("payload.exe"), null);
  assert.equal(classifyExtension("script.sh"), null);
});

test("classifyExtension accepts the documented allowlist", () => {
  assert.equal(classifyExtension("notes.txt"), "text");
  assert.equal(classifyExtension("report.pdf"), "pdf");
  assert.equal(classifyExtension("photo.png"), "image");
});

// --- magic-byte sniffing vs claimed extension (the core upload security test) ---

test("sniffMimeCategory detects a PNG regardless of filename", () => {
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(sniffMimeCategory(pngHeader), "image");
});

test("sniffMimeCategory detects a PDF header", () => {
  assert.equal(sniffMimeCategory(Buffer.from("%PDF-1.4 rest of file")), "pdf");
});

test("sniffMimeCategory flags a PNG smuggled under a .txt extension", () => {
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const declared = classifyExtension("fake.txt");
  const sniffed = sniffMimeCategory(pngHeader);
  assert.equal(declared, "text");
  assert.notEqual(declared, sniffed, "upload_finalize must reject this mismatch");
});

test("sniffMimeCategory treats plain text as text", () => {
  assert.equal(sniffMimeCategory(Buffer.from("Hallo Welt, dies ist ein Testdokument.")), "text");
});

test("sniffMimeCategory treats binary-with-NUL as unknown, not text", () => {
  assert.equal(sniffMimeCategory(Buffer.from([0x48, 0x00, 0x49])), "unknown");
});

// --- path containment ---

test("safeJoin rejects a segment that escapes the base directory", async () => {
  const base = path.join(process.cwd(), "data", "files");
  await assert.rejects(() => safeJoin(base, "../../../etc/passwd"), /escapes base directory/);
});

test("safeJoin accepts a plain opaque-looking segment", async () => {
  const base = path.join(process.cwd(), "data", "files");
  const id = newFileId();
  const resolved = await safeJoin(base, id);
  assert.ok(resolved.startsWith(base));
});

// --- hashing sanity ---

test("sha256Hex is deterministic", () => {
  const a = sha256Hex(Buffer.from("same input"));
  const b = sha256Hex(Buffer.from("same input"));
  assert.equal(a, b);
});
