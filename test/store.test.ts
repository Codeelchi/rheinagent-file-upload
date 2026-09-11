import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ensureDirs,
  createPendingUpload,
  stagingPath,
  finalizeFile,
  createDownloadTicket,
  getDownloadTicket,
  createDeleteTicket,
  applyDelete,
} from "../src/lib/store.js";
import { sha256Hex } from "../src/lib/security.js";

// Exercises the download-ticket flow (rheinagent_file_download_prepare +
// the data-plane GET) at the store layer, without spinning up either HTTP
// process — mirrors the manual end-to-end check done for the real servers.

const DATA_DIR = path.join(process.cwd(), "data");

async function acceptTestFile(name: string, bytes: string) {
  await ensureDirs();
  const pending = await createPendingUpload(name, Buffer.byteLength(bytes));
  const staged = await stagingPath(pending.uploadId);
  await fs.writeFile(staged, bytes, "utf-8");
  return finalizeFile(pending.uploadId, {
    filename: name,
    sizeBytes: Buffer.byteLength(bytes),
    mimeCategory: "text",
    sha256: sha256Hex(Buffer.from(bytes)),
  });
}

test("createDownloadTicket + getDownloadTicket round-trip for an accepted file", async () => {
  const record = await acceptTestFile("store-test-a.txt", "hello from the store test");
  const ticket = await createDownloadTicket(record.fileId);
  assert.equal(ticket.fileId, record.fileId);
  assert.match(ticket.downloadToken, /^dl_/);

  const fetched = await getDownloadTicket(ticket.downloadToken);
  assert.ok(fetched);
  assert.equal(fetched?.fileId, record.fileId);

  // Reusable within TTL — a second read of the same token still resolves,
  // unlike the one-shot delete_token.
  const fetchedAgain = await getDownloadTicket(ticket.downloadToken);
  assert.ok(fetchedAgain);
});

test("getDownloadTicket returns undefined for an unknown token", async () => {
  await ensureDirs();
  const fetched = await getDownloadTicket("dl_00000000-0000-0000-0000-000000000000");
  assert.equal(fetched, undefined);
});

test("createDownloadTicket refuses a file_id that was never accepted", async () => {
  await ensureDirs();
  await assert.rejects(() => createDownloadTicket("file_00000000-0000-0000-0000-000000000000"), /file not found/);
});

test("createDownloadTicket refuses a file that is pending-delete", async () => {
  const record = await acceptTestFile("store-test-b.txt", "will be deleted");
  const deleteTicket = await createDeleteTicket(record.fileId);
  await assert.rejects(() => createDownloadTicket(record.fileId), /file not found/);
  await applyDelete(deleteTicket.deleteToken); // cleanup: actually remove it
});

test.after(async () => {
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});
