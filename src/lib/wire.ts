import type { FileRecord, JobRecord, DeleteTicket } from "./store.js";

/**
 * Maps this product's internal (camelCase) store records onto the public,
 * snake_case wire shapes declared in src/lib/schemas.ts. Every tool handler
 * in server.ts that returns a FileRecord/JobRecord/DeleteTicket as
 * `structuredContent` goes through one of these instead of spreading the
 * internal record directly — keeps the internal TS convention and the
 * public MCP tool contract free to differ (and, right now, consistent with
 * every snake_case tool *input* field like file_id/processor_id) without
 * either one leaking into the other.
 */

export function toWireFile(record: FileRecord) {
  return {
    file_id: record.fileId,
    filename: record.filename,
    size_bytes: record.sizeBytes,
    mime_category: record.mimeCategory,
    sha256: record.sha256,
    created_at: record.createdAt,
    pending_delete: record.pendingDelete,
  };
}

export function toWireJob(job: JobRecord) {
  return {
    job_id: job.jobId,
    file_id: job.fileId,
    processor_id: job.processorId,
    options: job.options,
    state: job.state,
    created_at: job.createdAt,
    completed_at: job.completedAt,
    error: job.error,
  };
}

export function toWireDeleteTicket(ticket: DeleteTicket) {
  return {
    delete_token: ticket.deleteToken,
    file_id: ticket.fileId,
    created_at: ticket.createdAt,
  };
}
