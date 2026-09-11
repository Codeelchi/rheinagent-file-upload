import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { JsonIndex } from "./jsonIndex.js";
import { newUploadId, newFileId, newDeleteToken, newDownloadToken, newJobId, assertOpaqueId } from "./ids.js";
import { safeJoin, assertNotSymlink, classifyExtension, type MimeCategory } from "./security.js";

const DATA_DIR = path.join(import.meta.dirname, "..", "..", "data");
const STAGING_DIR = path.join(DATA_DIR, "staging");
const FILES_DIR = path.join(DATA_DIR, "files");
const RESULTS_DIR = path.join(DATA_DIR, "results");
const META_DIR = path.join(DATA_DIR, "meta");

const UPLOAD_TTL_MS = 15 * 60 * 1000;
const DOWNLOAD_TTL_MS = 15 * 60 * 1000;

export interface PendingUpload {
  uploadId: string;
  declaredFilename: string;
  declaredSizeBytes: number;
  createdAt: string;
  expiresAt: string;
}

export interface FileRecord {
  fileId: string;
  filename: string;
  sizeBytes: number;
  mimeCategory: MimeCategory;
  sha256: string;
  createdAt: string;
  pendingDelete: boolean;
}

export interface JobRecord {
  jobId: string;
  fileId: string;
  processorId: string;
  state: "prepared" | "completed" | "failed";
  createdAt: string;
  completedAt?: string;
  error?: string;
}

export interface DeleteTicket {
  deleteToken: string;
  fileId: string;
  createdAt: string;
}

export interface DownloadTicket {
  downloadToken: string;
  fileId: string;
  createdAt: string;
  expiresAt: string;
}

const uploads = new JsonIndex<PendingUpload>(path.join(META_DIR, "uploads.json"));
const files = new JsonIndex<FileRecord>(path.join(META_DIR, "files.json"));
const jobs = new JsonIndex<JobRecord>(path.join(META_DIR, "jobs.json"));
const deletes = new JsonIndex<DeleteTicket>(path.join(META_DIR, "deletes.json"));
const downloads = new JsonIndex<DownloadTicket>(path.join(META_DIR, "downloads.json"));

export async function ensureDirs(): Promise<void> {
  await fs.mkdir(STAGING_DIR, { recursive: true });
  await fs.mkdir(FILES_DIR, { recursive: true });
  await fs.mkdir(RESULTS_DIR, { recursive: true });
  await fs.mkdir(META_DIR, { recursive: true });
}

/** Non-destructive writability probe (fs.access, no file left behind) —
 * used by the health tool, per docs/VERSIONING.md's Health/Doctor-Konzept. */
async function isDirWritable(dir: string): Promise<boolean> {
  try {
    await fs.access(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function checkStagingDirWritable(): Promise<boolean> {
  return isDirWritable(STAGING_DIR);
}

export async function checkFilesDirWritable(): Promise<boolean> {
  return isDirWritable(FILES_DIR);
}

export async function stagingPath(uploadId: string): Promise<string> {
  assertOpaqueId(uploadId);
  return safeJoin(STAGING_DIR, uploadId);
}

export async function filePath(fileId: string): Promise<string> {
  assertOpaqueId(fileId);
  return safeJoin(FILES_DIR, fileId);
}

export async function resultPath(jobId: string): Promise<string> {
  assertOpaqueId(jobId);
  return safeJoin(RESULTS_DIR, `${jobId}.json`);
}

export async function createPendingUpload(filename: string, declaredSizeBytes: number): Promise<PendingUpload> {
  const uploadId = newUploadId();
  const now = Date.now();
  const pending: PendingUpload = {
    uploadId,
    declaredFilename: filename,
    declaredSizeBytes,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + UPLOAD_TTL_MS).toISOString(),
  };
  await uploads.set(uploadId, pending);
  return pending;
}

export async function getPendingUpload(uploadId: string): Promise<PendingUpload | undefined> {
  const pending = await uploads.get(uploadId);
  if (pending && new Date(pending.expiresAt).getTime() < Date.now()) {
    await uploads.delete(uploadId);
    return undefined;
  }
  return pending;
}

export async function consumePendingUpload(uploadId: string): Promise<void> {
  await uploads.delete(uploadId);
}

/**
 * Reclaims disk space from abandoned uploads. `getPendingUpload()` only
 * ever removes the *metadata* entry when it notices an expired id on
 * access — it never touches the actual staged bytes under
 * `data/staging/<upload_id>`, and nothing revisits an id nobody asks about
 * again. A client that PUTs bytes but never calls `upload_finalize` (or
 * never PUTs at all) therefore leaves that upload's bytes on disk forever
 * with no automatic cleanup path. This sweep removes every staged file
 * whose `upload_id` has no still-valid (non-expired) pending-upload entry,
 * and proactively drops the now-stale metadata entries too instead of
 * waiting for someone to access them. Safe to call anytime, including
 * concurrently with an in-flight PUT for a *different* id — an id that's
 * still within its TTL is never touched.
 */
export async function sweepOrphanedStaging(): Promise<{ removedFiles: number; removedEntries: number }> {
  const now = Date.now();
  const pending = await uploads.values();
  const validIds = new Set<string>();
  let removedEntries = 0;
  for (const p of pending) {
    if (new Date(p.expiresAt).getTime() < now) {
      await uploads.delete(p.uploadId);
      removedEntries++;
    } else {
      validIds.add(p.uploadId);
    }
  }

  let removedFiles = 0;
  const staged = await fs.readdir(STAGING_DIR).catch(() => [] as string[]);
  for (const name of staged) {
    if (validIds.has(name)) continue;
    await fs.unlink(path.join(STAGING_DIR, name)).catch(() => {});
    removedFiles++;
  }
  return { removedFiles, removedEntries };
}

export async function finalizeFile(
  uploadId: string,
  meta: { filename: string; sizeBytes: number; mimeCategory: MimeCategory; sha256: string },
): Promise<FileRecord> {
  const fileId = newFileId();
  const src = await stagingPath(uploadId);
  const dst = await filePath(fileId);
  await assertNotSymlink(dst);
  await fs.rename(src, dst); // atomic move within the same data volume
  const record: FileRecord = {
    fileId,
    filename: meta.filename,
    sizeBytes: meta.sizeBytes,
    mimeCategory: meta.mimeCategory,
    sha256: meta.sha256,
    createdAt: new Date().toISOString(),
    pendingDelete: false,
  };
  await files.set(fileId, record);
  return record;
}

export async function listFiles(): Promise<FileRecord[]> {
  const all = await files.values();
  return all.filter((f) => !f.pendingDelete);
}

const DEFAULT_PAGE_SIZE = 50;

/**
 * Deterministic, cursor-paginated file listing — mirrors the MCP
 * `tools/list`-style pagination utility (cursor/nextCursor) so
 * `rheinagent_file_list` doesn't grow unboundedly through MCP JSON as the
 * accepted-files set grows. Sort order (createdAt, then fileId as a
 * tiebreaker) is fixed so the same cursor always resumes at the same point
 * even if new files are uploaded concurrently.
 */
export async function listFilesPage(
  cursor?: string,
  limit: number = DEFAULT_PAGE_SIZE,
): Promise<{ files: FileRecord[]; nextCursor?: string }> {
  const all = (await listFiles()).sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.fileId.localeCompare(b.fileId),
  );
  let startIndex = 0;
  if (cursor) {
    const idx = all.findIndex((f) => f.fileId === cursor);
    startIndex = idx >= 0 ? idx + 1 : 0;
  }
  const page = all.slice(startIndex, startIndex + limit);
  const nextCursor = startIndex + limit < all.length ? page[page.length - 1]?.fileId : undefined;
  return { files: page, nextCursor };
}

export async function getFile(fileId: string): Promise<FileRecord | undefined> {
  assertOpaqueId(fileId);
  return files.get(fileId);
}

/**
 * Renames a file's display name in place — file_id, bytes, sha256, and
 * mime_category never change. `new_filename`'s extension must still
 * classify to the *same* mime_category as the already magic-byte-verified
 * bytes on disk: renaming validated `.txt` bytes to `report.pdf` would
 * silently relabel content that was never checked as PDF, undermining the
 * upload_finalize sniff/extension consistency check for anything that
 * later trusts mime_category (e.g. which processor_id is offered for this
 * file). A rename that would change the effective category is rejected,
 * not silently coerced.
 */
export async function renameFile(fileId: string, newFilename: string): Promise<FileRecord> {
  const record = await files.get(fileId);
  if (!record || record.pendingDelete) throw new Error("file not found");
  const newCategory = classifyExtension(newFilename);
  if (newCategory === null) {
    throw new Error(`extension of "${newFilename}" is not allowed`);
  }
  if (newCategory !== record.mimeCategory) {
    throw new Error(
      `renaming to "${newFilename}" would change mime_category from "${record.mimeCategory}" to "${newCategory}" — not allowed, the underlying bytes were only ever validated as "${record.mimeCategory}"`,
    );
  }
  const updated: FileRecord = { ...record, filename: newFilename };
  await files.set(fileId, updated);
  return updated;
}

/** Live disk-usage snapshot for the health tool — counts every accepted
 * file (including ones currently `pendingDelete`, since their bytes are
 * still on disk until `delete_apply` actually runs) plus how many bytes
 * are currently sitting in staging (in-flight or not-yet-swept uploads). */
export async function getStorageStats(): Promise<{ fileCount: number; totalBytes: number; stagingFileCount: number }> {
  const all = await files.values();
  const totalBytes = all.reduce((sum, f) => sum + f.sizeBytes, 0);
  const staged = await fs.readdir(STAGING_DIR).catch(() => [] as string[]);
  return { fileCount: all.length, totalBytes, stagingFileCount: staged.length };
}

/**
 * Download tickets gate the data-plane GET endpoint: a client must first
 * call the control-plane `rheinagent_file_download_prepare` tool (which
 * checks the file actually exists and isn't pending-delete) to get a
 * short-lived, unguessable `download_token`. The token is deliberately
 * reusable within its TTL (unlike the one-shot delete_token) since a GET
 * is read-only and idempotent — a client retrying a download shouldn't
 * need to re-prepare.
 */
export async function createDownloadTicket(fileId: string): Promise<DownloadTicket> {
  const record = await files.get(fileId);
  if (!record || record.pendingDelete) throw new Error("file not found");
  const now = Date.now();
  const ticket: DownloadTicket = {
    downloadToken: newDownloadToken(),
    fileId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + DOWNLOAD_TTL_MS).toISOString(),
  };
  await downloads.set(ticket.downloadToken, ticket);
  return ticket;
}

export async function getDownloadTicket(downloadToken: string): Promise<DownloadTicket | undefined> {
  const ticket = await downloads.get(downloadToken);
  if (ticket && new Date(ticket.expiresAt).getTime() < Date.now()) {
    await downloads.delete(downloadToken);
    return undefined;
  }
  return ticket;
}

export async function createDeleteTicket(fileId: string): Promise<DeleteTicket> {
  const record = await files.get(fileId);
  if (!record) throw new Error("file not found");
  const ticket: DeleteTicket = {
    deleteToken: newDeleteToken(),
    fileId,
    createdAt: new Date().toISOString(),
  };
  await deletes.set(ticket.deleteToken, ticket);
  await files.set(fileId, { ...record, pendingDelete: true });
  return ticket;
}

/**
 * Removes every job (and its stored result, if any) for a given file. Called
 * as part of `applyDelete()` so "delete this file" actually means delete —
 * without this, a completed job's result (e.g. `text_uppercase`'s
 * `transformed_text`, which IS the file's full content) would keep living
 * in data/results/ and stay retrievable via rheinagent_file_result_get
 * indefinitely after the source file itself is gone.
 */
async function cascadeDeleteJobsForFile(fileId: string): Promise<void> {
  const allJobs = await jobs.values();
  for (const job of allJobs) {
    if (job.fileId !== fileId) continue;
    await jobs.delete(job.jobId);
    const resultFile = await resultPath(job.jobId);
    await fs.unlink(resultFile).catch(() => {}); // no result yet (job never completed) is fine
  }
}

export async function applyDelete(deleteToken: string): Promise<FileRecord> {
  const ticket = await deletes.get(deleteToken);
  if (!ticket) throw new Error("delete ticket not found or already applied");
  const record = await files.get(ticket.fileId);
  if (!record) throw new Error("file not found");
  const target = await filePath(ticket.fileId);
  await fs.unlink(target);
  await files.delete(ticket.fileId);
  await deletes.delete(deleteToken);
  await cascadeDeleteJobsForFile(ticket.fileId);
  return record;
}

export async function createJob(fileId: string, processorId: string): Promise<JobRecord> {
  const job: JobRecord = {
    jobId: newJobId(),
    fileId,
    processorId,
    state: "prepared",
    createdAt: new Date().toISOString(),
  };
  await jobs.set(job.jobId, job);
  return job;
}

export async function getJob(jobId: string): Promise<JobRecord | undefined> {
  assertOpaqueId(jobId);
  return jobs.get(jobId);
}

/**
 * Cursor-paginated job listing, optionally scoped to one file_id — the
 * `rheinagent_file_list` counterpart for jobs. Without this, losing a
 * job_id (or simply wanting "what jobs exist for this file") had no
 * recovery path other than re-running rheinagent_file_process_prepare and
 * creating a duplicate job. Same sort/pagination shape as
 * `listFilesPage()` (createdAt, then jobId as tiebreaker) for consistency.
 */
export async function listJobsPage(
  fileId?: string,
  cursor?: string,
  limit: number = DEFAULT_PAGE_SIZE,
): Promise<{ jobs: JobRecord[]; nextCursor?: string }> {
  let all = await jobs.values();
  if (fileId) all = all.filter((j) => j.fileId === fileId);
  all = all.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.jobId.localeCompare(b.jobId));
  let startIndex = 0;
  if (cursor) {
    const idx = all.findIndex((j) => j.jobId === cursor);
    startIndex = idx >= 0 ? idx + 1 : 0;
  }
  const page = all.slice(startIndex, startIndex + limit);
  const nextCursor = startIndex + limit < all.length ? page[page.length - 1]?.jobId : undefined;
  return { jobs: page, nextCursor };
}

export async function updateJob(jobId: string, patch: Partial<JobRecord>): Promise<void> {
  const job = await jobs.get(jobId);
  if (!job) throw new Error("job not found");
  await jobs.set(jobId, { ...job, ...patch });
}

export async function writeJobResult(jobId: string, data: unknown): Promise<void> {
  const dst = await resultPath(jobId);
  await assertNotSymlink(dst);
  const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tmp, dst); // atomic result creation
}

export async function readJobResult(jobId: string): Promise<unknown | undefined> {
  try {
    const dst = await resultPath(jobId);
    return JSON.parse(await fs.readFile(dst, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}
