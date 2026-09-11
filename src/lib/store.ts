import fs from "node:fs/promises";
import path from "node:path";
import { JsonIndex } from "./jsonIndex.js";
import { newUploadId, newFileId, newDeleteToken, newDownloadToken, newJobId, assertOpaqueId } from "./ids.js";
import { safeJoin, assertNotSymlink, type MimeCategory } from "./security.js";

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

export async function applyDelete(deleteToken: string): Promise<FileRecord> {
  const ticket = await deletes.get(deleteToken);
  if (!ticket) throw new Error("delete ticket not found or already applied");
  const record = await files.get(ticket.fileId);
  if (!record) throw new Error("file not found");
  const target = await filePath(ticket.fileId);
  await fs.unlink(target);
  await files.delete(ticket.fileId);
  await deletes.delete(deleteToken);
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
