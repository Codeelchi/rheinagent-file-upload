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
  listJobsPage,
  writeJobResult,
  readJobResult,
  renameFile,
  getStorageStats,
  listFilesPage,
  updateJob,
  verifyFile,
  filePath,
} from "../src/lib/store.js";
import { sha256Hex, type MimeCategory } from "../src/lib/security.js";

// Exercises the download-ticket flow (rheinagent_file_download_prepare +
// the data-plane GET) at the store layer, without spinning up either HTTP
// process — mirrors the manual end-to-end check done for the real servers.

const DATA_DIR = path.join(process.cwd(), "data");

async function acceptTestFile(name: string, bytes: string, mimeCategory: MimeCategory = "text") {
  await ensureDirs();
  const pending = await createPendingUpload(name, Buffer.byteLength(bytes));
  const staged = await stagingPath(pending.uploadId);
  await fs.writeFile(staged, bytes, "utf-8");
  return finalizeFile(pending.uploadId, {
    filename: name,
    sizeBytes: Buffer.byteLength(bytes),
    mimeCategory,
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

// --- createJob options passthrough ---

test("createJob persists options and omits the field entirely when none given", async () => {
  const f = await acceptTestFile("store-test-job-options.pdf", "x", "pdf");
  const withOptions = await createJob(f.fileId, "pdf_extract_text", { page: 2 });
  assert.deepEqual(withOptions.options, { page: 2 });

  const withoutOptions = await createJob(f.fileId, "pdf_metadata");
  assert.equal("options" in withoutOptions, false);

  const t = await createDeleteTicket(f.fileId);
  await applyDelete(t.deleteToken);
});

// --- job listing ---

test("listJobsPage lists jobs across files and filters by file_id", async () => {
  const a = await acceptTestFile("store-test-joblist-a.txt", "aaa");
  const b = await acceptTestFile("store-test-joblist-b.txt", "bbb");
  const jobA1 = await createJob(a.fileId, "text_stats");
  const jobA2 = await createJob(a.fileId, "text_uppercase");
  const jobB1 = await createJob(b.fileId, "text_stats");

  const allForA = await listJobsPage({ fileId: a.fileId });
  const idsForA = allForA.jobs.map((j) => j.jobId).sort();
  assert.deepEqual(idsForA, [jobA1.jobId, jobA2.jobId].sort());

  const unfiltered = await listJobsPage();
  const unfilteredIds = unfiltered.jobs.map((j) => j.jobId);
  assert.ok(unfilteredIds.includes(jobA1.jobId));
  assert.ok(unfilteredIds.includes(jobB1.jobId));

  // cleanup
  for (const f of [a, b]) {
    const t = await createDeleteTicket(f.fileId);
    await applyDelete(t.deleteToken);
  }
});

test("listJobsPage paginates via cursor/limit like listFilesPage", async () => {
  const f = await acceptTestFile("store-test-joblist-page.txt", "x");
  const created = [];
  for (let i = 0; i < 3; i++) created.push(await createJob(f.fileId, "text_stats"));

  const page1 = await listJobsPage({ fileId: f.fileId }, undefined, 2);
  assert.equal(page1.jobs.length, 2);
  assert.ok(page1.nextCursor);

  const page2 = await listJobsPage({ fileId: f.fileId }, page1.nextCursor, 2);
  assert.equal(page2.jobs.length, 1);
  assert.equal(page2.nextCursor, undefined);

  const t = await createDeleteTicket(f.fileId);
  await applyDelete(t.deleteToken);
});

// --- rename: filename only, never bytes/mime_category ---

test("renameFile changes filename and preserves file_id/sha256/mime_category", async () => {
  const record = await acceptTestFile("store-test-rename-a.txt", "content");
  const renamed = await renameFile(record.fileId, "store-test-rename-a-v2.txt");
  assert.equal(renamed.fileId, record.fileId);
  assert.equal(renamed.sha256, record.sha256);
  assert.equal(renamed.mimeCategory, "text");
  assert.equal(renamed.filename, "store-test-rename-a-v2.txt");

  const t = await createDeleteTicket(record.fileId);
  await applyDelete(t.deleteToken);
});

test("renameFile rejects a new filename that would change mime_category", async () => {
  const record = await acceptTestFile("store-test-rename-b.txt", "content");
  await assert.rejects(() => renameFile(record.fileId, "store-test-rename-b.pdf"), /would change mime_category/);

  const t = await createDeleteTicket(record.fileId);
  await applyDelete(t.deleteToken);
});

test("renameFile rejects an unknown file_id", async () => {
  await ensureDirs();
  await assert.rejects(() => renameFile("file_00000000-0000-0000-0000-000000000000", "x.txt"), /file not found/);
});

// --- verify: integrity re-check against the recorded sha256 ---

test("verifyFile reports matches:true for untouched bytes", async () => {
  const record = await acceptTestFile("store-test-verify-ok.txt", "unchanged content");
  const result = await verifyFile(record.fileId);
  assert.equal(result.matches, true);
  assert.equal(result.actualSha256, record.sha256);

  const t = await createDeleteTicket(record.fileId);
  await applyDelete(t.deleteToken);
});

test("verifyFile reports matches:false after the bytes on disk are tampered with out of band", async () => {
  const record = await acceptTestFile("store-test-verify-tampered.txt", "original content");
  const onDisk = await filePath(record.fileId);
  await fs.writeFile(onDisk, "tampered content", "utf-8"); // simulates corruption/out-of-band edit

  const result = await verifyFile(record.fileId);
  assert.equal(result.matches, false);
  assert.notEqual(result.actualSha256, record.sha256);

  // restore + cleanup so applyDelete's own unlink doesn't care either way
  const t = await createDeleteTicket(record.fileId);
  await applyDelete(t.deleteToken);
});

test("verifyFile rejects an unknown file_id", async () => {
  await ensureDirs();
  await assert.rejects(() => verifyFile("file_00000000-0000-0000-0000-000000000000"), /file not found/);
});

// --- storage stats (health tool) ---

test("getStorageStats reflects accepted files and staged bytes", async () => {
  await ensureDirs();
  const before = await getStorageStats();

  const record = await acceptTestFile("store-test-storage.txt", "12345");
  const pending = await createPendingUpload("store-test-storage-staged.txt", 3);
  const staged = await stagingPath(pending.uploadId);
  await fs.writeFile(staged, "abc", "utf-8");

  const after = await getStorageStats();
  assert.equal(after.fileCount, before.fileCount + 1);
  assert.equal(after.totalBytes, before.totalBytes + 5);
  assert.equal(after.stagingFileCount, before.stagingFileCount + 1);

  // cleanup
  const t = await createDeleteTicket(record.fileId);
  await applyDelete(t.deleteToken);
  await consumePendingUpload(pending.uploadId);
  await fs.unlink(staged).catch(() => {});
});

test("getStorageStats breaks usage down by mime_category", async () => {
  await ensureDirs();
  const txt = await acceptTestFile("store-test-bymime.txt", "12345", "text");
  const pdf = await acceptTestFile("store-test-bymime.pdf", "1234567890", "pdf");

  const stats = await getStorageStats();
  assert.equal(stats.byMimeCategory.text?.count && stats.byMimeCategory.text.count >= 1, true);
  assert.ok((stats.byMimeCategory.text?.bytes ?? 0) >= 5);
  assert.equal(stats.byMimeCategory.pdf?.count, 1);
  assert.equal(stats.byMimeCategory.pdf?.bytes, 10);

  for (const f of [txt, pdf]) {
    const t = await createDeleteTicket(f.fileId);
    await applyDelete(t.deleteToken);
  }
});

// --- rheinagent_file_list filtering ---

test("listFilesPage filters by mime_category", async () => {
  const txt = await acceptTestFile("store-test-filter.txt", "a", "text");
  const pdf = await acceptTestFile("store-test-filter.pdf", "aa", "pdf");

  const pdfOnly = await listFilesPage({ mimeCategory: "pdf" });
  const ids = pdfOnly.files.map((f) => f.fileId);
  assert.ok(ids.includes(pdf.fileId));
  assert.ok(!ids.includes(txt.fileId));

  for (const f of [txt, pdf]) {
    const t = await createDeleteTicket(f.fileId);
    await applyDelete(t.deleteToken);
  }
});

test("listFilesPage filters by case-insensitive filename_contains", async () => {
  const match = await acceptTestFile("Store-Test-Invoice-2026.txt", "a");
  const noMatch = await acceptTestFile("store-test-receipt.txt", "a");

  const filtered = await listFilesPage({ filenameContains: "invoice" });
  const ids = filtered.files.map((f) => f.fileId);
  assert.ok(ids.includes(match.fileId), "case-insensitive substring match must find it");
  assert.ok(!ids.includes(noMatch.fileId));

  for (const f of [match, noMatch]) {
    const t = await createDeleteTicket(f.fileId);
    await applyDelete(t.deleteToken);
  }
});

// --- rheinagent_file_job_list filtering ---

test("listJobsPage filters by state and processor_id", async () => {
  const f = await acceptTestFile("store-test-jobfilter.txt", "a");
  const prepared = await createJob(f.fileId, "text_stats");
  const completed = await createJob(f.fileId, "text_uppercase");
  await updateJob(completed.jobId, { state: "completed", completedAt: new Date().toISOString() });

  const onlyCompleted = await listJobsPage({ fileId: f.fileId, state: "completed" });
  assert.deepEqual(onlyCompleted.jobs.map((j) => j.jobId), [completed.jobId]);

  const onlyTextStats = await listJobsPage({ fileId: f.fileId, processorId: "text_stats" });
  assert.deepEqual(onlyTextStats.jobs.map((j) => j.jobId), [prepared.jobId]);

  const t = await createDeleteTicket(f.fileId);
  await applyDelete(t.deleteToken);
});

test.after(async () => {
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});
