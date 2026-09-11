import { z } from "zod";

/**
 * Shared zod schemas for tool `outputSchema` declarations. Per the MCP
 * 2026-07-28 tools spec, declaring `outputSchema` lets clients validate
 * `structuredContent` instead of trusting it blindly — every tool below
 * returns exactly one of these shapes.
 */

export const FileRecordSchema = z.object({
  fileId: z.string(),
  filename: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  mimeCategory: z.enum(["text", "pdf", "image", "archive", "unknown"]),
  sha256: z.string(),
  createdAt: z.string(),
  pendingDelete: z.boolean(),
});

export const JobRecordSchema = z.object({
  jobId: z.string(),
  fileId: z.string(),
  processorId: z.string(),
  state: z.enum(["prepared", "completed", "failed"]),
  createdAt: z.string(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
});

export const CapabilitiesSchema = z.object({
  product_slug: z.string(),
  mcp_protocol_version: z.string(),
  package_profile: z.string(),
  audit_profile: z.string(),
  health_profile: z.string(),
  audit_mode: z.enum(["off", "hub"]),
  limits: z.object({
    max_upload_bytes: z.number().int().positive(),
    allowed_mime_categories: z.array(z.string()),
  }),
  processors: z.array(z.string()),
});

export const UploadPrepareResultSchema = z.object({
  upload_id: z.string(),
  upload_url: z.string(),
  expires_at: z.string(),
});

export const FileListResultSchema = z.object({
  files: z.array(FileRecordSchema),
  next_cursor: z.string().optional(),
});

export const FileViewResultSchema = FileRecordSchema.extend({
  content: z.string().optional(),
});

export const JobResultEnvelopeSchema = z.object({
  job_id: z.string(),
  result: z.record(z.string(), z.unknown()),
});

export const DeleteTicketResultSchema = z.object({
  deleteToken: z.string(),
  fileId: z.string(),
  createdAt: z.string(),
});

export const DownloadPrepareResultSchema = z.object({
  download_token: z.string(),
  download_url: z.string(),
  expires_at: z.string(),
});
