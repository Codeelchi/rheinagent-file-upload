import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ensureDirs,
  createPendingUpload,
  consumePendingUpload,
  stagingPath,
  finalizeFile,
  createDownloadTicket,
  getDownloadTicket,
  createDeleteTicket,
  applyDelete,
  checkStagingDirWritable,
  checkFilesDirWritable,
  sweepOrphanedStaging,
  createJob,
  getJob,
  writeJobResult,
  readJobResult,
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

// --- health/doctor writability probes ---

test("checkStagingDirWritable/checkFilesDirWritable report true once ensureDirs has run", async () => {
  await ensureDirs();
  assert.equal(await checkStagingDirWritable(), true);
  assert.equal(await checkFilesDirWritable(), true);
});

// --- cascade delete: a deleted file's jobs/results must not survive it ---

test("applyDelete removes jobs and stored results for the deleted file", async () => {
  const record = await acceptTestFile("store-test-cascade.txt", "cascade me");
  const job = await createJob(record.fileId, "text_uppercase");
  await writeJobResult(job.jobId, { transformed_text: "CASCADE ME" });

  const deleteTicket = await createDeleteTicket(record.fileId);
  await applyDelete(deleteTicket.deleteToken);

  assert.equal(await getJob(job.jobId), undefined, "job must not survive its file's deletion");
  assert.equal(await readJobResult(job.jobId), undefined, "result content must not survive its file's deletion");
});

test("applyDelete leaves other files' jobs/results untouched", async () => {
  const keep = await acceptTestFile("store-test-keep.txt", "keep me");
  const gone = await acceptTestFile("store-test-gone.txt", "delete me");
  const keepJob = await createJob(keep.fileId, "text_stats");
  const goneJob = await createJob(gone.fileId, "text_stats");
  await writeJobResult(keepJob.jobId, { line_count: 1 });
  await writeJobResult(goneJob.jobId, { line_count: 1 });

  const deleteTicket = await createDeleteTicket(gone.fileId);
  await applyDelete(deleteTicket.deleteToken);

  assert.ok(await getJob(keepJob.jobId), "unrelated job must survive");
  assert.ok(await readJobResult(keepJob.jobId), "unrelated result must survive");
  assert.equal(await getJob(goneJob.jobId), undefined);

  // cleanup
  const cleanupTicket = await createDeleteTicket(keep.fileId);
  await applyDelete(cleanupTicket.deleteToken);
});

// --- staging reaper: abandoned upload bytes must not accumulate forever ---

test("sweepOrphanedStaging removes staged bytes with no matching pending-upload entry", async () => {
  await ensureDirs();
  const pending = await createPendingUpload("orphan.txt", 5);
  const staged = await stagingPath(pending.uploadId);
  await fs.writeFile(staged, "hello", "utf-8");
  // Simulates the metadata entry being gone (e.g. already expired-and-swept
  // on a prior access) while the bytes themselves were never cleaned up.
  await consumePendingUpload(pending.uploadId);

  await assert.doesNotReject(() => fs.access(staged));
  const result = await sweepOrphanedStaging();
  assert.ok(result.removedFiles >= 1);
  await assert.rejects(() => fs.access(staged));
});

test("sweepOrphanedStaging keeps staged bytes for a still-valid pending upload", async () => {
  await ensureDirs();
  const pending = await createPendingUpload("keep-staged.txt", 5);
  const staged = await stagingPath(pending.uploadId);
  await fs.writeFile(staged, "hello", "utf-8");

  await sweepOrphanedStaging();
  await assert.doesNotReject(() => fs.access(staged), "not expired yet, must not be swept");

  await consumePendingUpload(pending.uploadId);
  await fs.unlink(staged).catch(() => {});
});

test.after(async () => {
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});
