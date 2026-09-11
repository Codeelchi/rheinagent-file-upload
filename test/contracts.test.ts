import { test } from "node:test";
import assert from "node:assert/strict";
import { FileIdField, JobIdField, UploadIdField, DeleteTokenField, HealthSchema } from "../src/lib/schemas.js";
import { toWireFile, toWireJob, toWireDeleteTicket } from "../src/lib/wire.js";
import { newFileId, newJobId, newUploadId, newDeleteToken } from "../src/lib/ids.js";
import type { FileRecord, JobRecord, DeleteTicket } from "../src/lib/store.js";

// Per-kind id field validation (server.ts inputSchemas) — this is what
// turns a malformed or wrong-kind id into a clean MCP schema-validation
// error instead of a generic "internal error in <tool>".

test("FileIdField accepts a real file_id and rejects other id kinds / garbage", () => {
  assert.equal(FileIdField.safeParse(newFileId()).success, true);
  assert.equal(FileIdField.safeParse(newJobId()).success, false, "job_id must not pass as file_id");
  assert.equal(FileIdField.safeParse("../../etc/passwd").success, false);
  assert.equal(FileIdField.safeParse("").success, false);
});

test("JobIdField/UploadIdField/DeleteTokenField each accept only their own kind", () => {
  assert.equal(JobIdField.safeParse(newJobId()).success, true);
  assert.equal(JobIdField.safeParse(newFileId()).success, false);

  assert.equal(UploadIdField.safeParse(newUploadId()).success, true);
  assert.equal(UploadIdField.safeParse(newDeleteToken()).success, false);

  assert.equal(DeleteTokenField.safeParse(newDeleteToken()).success, true);
  assert.equal(DeleteTokenField.safeParse(newUploadId()).success, false);
});

// Wire mappers — public tool contracts are snake_case (see schemas.ts);
// these convert the internal camelCase store records at the boundary.

test("toWireFile produces the snake_case FileRecordSchema shape", () => {
  const record: FileRecord = {
    fileId: newFileId(),
    filename: "a.txt",
    sizeBytes: 3,
    mimeCategory: "text",
    sha256: "deadbeef",
    createdAt: "2026-01-01T00:00:00.000Z",
    pendingDelete: false,
  };
  assert.deepEqual(toWireFile(record), {
    file_id: record.fileId,
    filename: "a.txt",
    size_bytes: 3,
    mime_category: "text",
    sha256: "deadbeef",
    created_at: "2026-01-01T00:00:00.000Z",
    pending_delete: false,
  });
});

test("toWireJob produces the snake_case JobRecordSchema shape", () => {
  const job: JobRecord = {
    jobId: newJobId(),
    fileId: newFileId(),
    processorId: "text_stats",
    state: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  };
  const wire = toWireJob(job);
  assert.equal(wire.job_id, job.jobId);
  assert.equal(wire.file_id, job.fileId);
  assert.equal(wire.processor_id, "text_stats");
  assert.equal(wire.completed_at, job.completedAt);
  assert.equal(wire.error, undefined);
});

test("toWireDeleteTicket produces the snake_case DeleteTicketResultSchema shape", () => {
  const ticket: DeleteTicket = {
    deleteToken: newDeleteToken(),
    fileId: newFileId(),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  assert.deepEqual(toWireDeleteTicket(ticket), {
    delete_token: ticket.deleteToken,
    file_id: ticket.fileId,
    created_at: "2026-01-01T00:00:00.000Z",
  });
});

// Regression test: HealthSchema.storage.by_mime_category must accept a
// partial object (only mime categories that actually have a file present)
// — a plain z.record(MimeCategorySchema, ...) instead of z.partialRecord
// requires every enum member as a key and rejects any real instance that
// hasn't seen an "archive" upload, which live testing caught as an
// "Output validation error" on rheinagent_file_health_get.
test("HealthSchema accepts storage.by_mime_category with only some categories present", () => {
  const body = {
    health_profile: "rheinagent-file-upload-v1",
    status: "ok" as const,
    control_plane_reachable: true as const,
    data_plane_reachable: true,
    staging_dir_writable: true,
    files_dir_writable: true,
    storage: {
      file_count: 2,
      total_bytes: 30,
      staging_file_count: 0,
      by_mime_category: { text: { count: 2, bytes: 30 } },
    },
    audit: { mode: "off" as const },
  };
  const parsed = HealthSchema.safeParse(body);
  assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues));
});
