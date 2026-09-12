import { test } from "node:test";
import assert from "node:assert/strict";
import { FileIdField, JobIdField, UploadIdField, DeleteTokenField, HealthSchema, Sha256Field, DuplicateCheckInputSchema } from "../src/lib/schemas.js";
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

test("toWireJob carries options through when present", () => {
  const job: JobRecord = {
    jobId: newJobId(),
    fileId: newFileId(),
    processorId: "pdf_extract_text",
    options: { page: 3 },
    state: "prepared",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  assert.deepEqual(toWireJob(job).options, { page: 3 });
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
    product_version: "0.2.0",
    state_schema_version: 1,
    status: "ok" as const,
    control_plane_reachable: true as const,
    data_plane_reachable: true,
    staging_dir_writable: true,
    files_dir_writable: true,
    processor_registry: { processor_count: 11 },
    jobs: { prepared: 0, completed: 0, failed: 0 },
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

test("Sha256Field accepts a real 64-char lowercase hex digest, rejects everything else", () => {
  const real = "a".repeat(64);
  assert.equal(Sha256Field.safeParse(real).success, true);
  assert.equal(Sha256Field.safeParse(real.toUpperCase()).success, false, "must be lowercase");
  assert.equal(Sha256Field.safeParse(real.slice(0, 63)).success, false, "too short");
  assert.equal(Sha256Field.safeParse(`${real}0`).success, false, "too long");
  assert.equal(Sha256Field.safeParse("not-hex-at-all").success, false);
});

test("DuplicateCheckInputSchema requires exactly one of file_id/sha256", () => {
  const fileId = newFileId();
  const sha = "a".repeat(64);
  assert.equal(DuplicateCheckInputSchema.safeParse({ file_id: fileId }).success, true);
  assert.equal(DuplicateCheckInputSchema.safeParse({ sha256: sha }).success, true);
  assert.equal(DuplicateCheckInputSchema.safeParse({}).success, false, "neither given");
  assert.equal(DuplicateCheckInputSchema.safeParse({ file_id: fileId, sha256: sha }).success, false, "both given");
});
