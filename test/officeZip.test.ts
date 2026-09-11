import { test } from "node:test";
import assert from "node:assert/strict";
import { readZipEntries } from "../src/lib/officeZip.js";
import { buildZip, buildSampleDocx } from "./testZip.js";

// The bounded ZIP reader underneath docx_extract_text/xlsx_inspect — the
// actual defense against zip-bomb-style attacks on office document uploads
// (docs/SECURITY.md's "ZIP bomb"/"extreme sharedStrings" test requirements).

test("readZipEntries extracts only the wanted entry, ignoring others", () => {
  const zip = buildZip([
    { name: "wanted.txt", content: Buffer.from("hello") },
    { name: "ignored.txt", content: Buffer.from("should never be touched") },
  ]);
  const entries = readZipEntries(zip, { wantedNames: new Set(["wanted.txt"]), maxEntryInflatedBytes: 1024, maxTotalInflatedBytes: 1024 });
  assert.equal(entries.size, 1);
  assert.equal(entries.get("wanted.txt")?.toString("utf-8"), "hello");
  assert.equal(entries.has("ignored.txt"), false);
});

test("readZipEntries supports both stored and deflated entries", () => {
  const zip = buildZip([
    { name: "stored.txt", content: Buffer.from("stored content"), method: "store" },
    { name: "deflated.txt", content: Buffer.from("deflated content"), method: "deflate" },
  ]);
  const entries = readZipEntries(zip, {
    wantedNames: new Set(["stored.txt", "deflated.txt"]),
    maxEntryInflatedBytes: 1024,
    maxTotalInflatedBytes: 1024,
  });
  assert.equal(entries.get("stored.txt")?.toString("utf-8"), "stored content");
  assert.equal(entries.get("deflated.txt")?.toString("utf-8"), "deflated content");
});

test("readZipEntries returns an empty map for a wanted name that isn't in the archive", () => {
  const zip = buildZip([{ name: "present.txt", content: Buffer.from("x") }]);
  const entries = readZipEntries(zip, { wantedNames: new Set(["missing.txt"]), maxEntryInflatedBytes: 1024, maxTotalInflatedBytes: 1024 });
  assert.equal(entries.size, 0);
});

test("readZipEntries rejects a buffer that isn't a valid ZIP container", () => {
  const notAZip = Buffer.from("this is definitely not a zip file");
  assert.throws(
    () => readZipEntries(notAZip, { wantedNames: new Set(["x"]), maxEntryInflatedBytes: 1024, maxTotalInflatedBytes: 1024 }),
    /not a valid ZIP container/,
  );
});

test("readZipEntries rejects an archive declaring more entries than the hard cap", () => {
  const entries = Array.from({ length: 5001 }, (_, i) => ({ name: `f${i}.txt`, content: Buffer.from("x") }));
  const zip = buildZip(entries);
  assert.throws(
    () => readZipEntries(zip, { wantedNames: new Set(["f0.txt"]), maxEntryInflatedBytes: 1024, maxTotalInflatedBytes: 1024 }),
    /exceeding the 5000 limit/,
  );
});

test("readZipEntries rejects an entry that would inflate past maxEntryInflatedBytes (zip bomb defense)", () => {
  // Highly compressible: 5 MB of the same byte compresses to almost nothing,
  // but must still be rejected before that 5 MB is ever materialized.
  const huge = Buffer.alloc(5 * 1024 * 1024, 65);
  const zip = buildZip([{ name: "bomb.xml", content: huge, method: "deflate" }]);
  assert.throws(
    () => readZipEntries(zip, { wantedNames: new Set(["bomb.xml"]), maxEntryInflatedBytes: 1024, maxTotalInflatedBytes: 1024 * 1024 }),
    /inflation budget|corrupt/,
  );
});

test("readZipEntries rejects a stored (uncompressed) entry exceeding the cap too", () => {
  const zip = buildZip([{ name: "big.bin", content: Buffer.alloc(2048, 1), method: "store" }]);
  assert.throws(() =>
    readZipEntries(zip, { wantedNames: new Set(["big.bin"]), maxEntryInflatedBytes: 1024, maxTotalInflatedBytes: 1024 * 1024 }),
  );
});

test("readZipEntries enforces a cumulative cap across multiple wanted entries", () => {
  const zip = buildZip([
    { name: "a.bin", content: Buffer.alloc(700, 1), method: "store" },
    { name: "b.bin", content: Buffer.alloc(700, 2), method: "store" },
  ]);
  assert.throws(() =>
    readZipEntries(zip, { wantedNames: new Set(["a.bin", "b.bin"]), maxEntryInflatedBytes: 1000, maxTotalInflatedBytes: 1000 }),
  );
});

test("readZipEntries round-trips a real docx-shaped archive", () => {
  const docx = buildSampleDocx();
  const entries = readZipEntries(docx, {
    wantedNames: new Set(["[Content_Types].xml", "word/document.xml"]),
    maxEntryInflatedBytes: 1024 * 1024,
    maxTotalInflatedBytes: 1024 * 1024,
  });
  assert.match(entries.get("[Content_Types].xml")?.toString("utf-8") ?? "", /wordprocessingml\.document\.main/);
  assert.match(entries.get("word/document.xml")?.toString("utf-8") ?? "", /Hello from a test DOCX document/);
});
