import { z } from "zod";
import { idPattern, ID_PREFIXES } from "./ids.js";

/**
 * Shared zod schemas for tool `outputSchema` declarations. Per the MCP
 * 2026-07-28 tools spec, declaring `outputSchema` lets clients validate
 * `structuredContent` instead of trusting it blindly — every tool below
 * returns exactly one of these shapes.
 */

/**
 * Per-kind opaque-id `inputSchema` fields, shared across every tool that
 * takes a file_id/job_id/upload_id/delete_token. Without this, a malformed
 * id (or an id of the wrong kind, e.g. a job_id passed as file_id) only
 * fails deep inside store.ts's `assertOpaqueId()` — the `guarded()` wrapper
 * in server.ts then reports it as a generic "internal error in <tool>",
 * which is honest (nothing unsafe happened) but unhelpful to a caller
 * (human or LLM) trying to figure out what went wrong. Validating the shape
 * at the zod `inputSchema` layer instead makes the MCP SDK reject it before
 * the handler even runs, with a standard schema-validation error that names
 * the field and the expected pattern.
 */
export const FileIdField = z.string().regex(idPattern(ID_PREFIXES.file), "must be a file_id previously returned by this server");
export const JobIdField = z.string().regex(idPattern(ID_PREFIXES.job), "must be a job_id previously returned by this server");
export const UploadIdField = z.string().regex(idPattern(ID_PREFIXES.upload), "must be an upload_id previously returned by this server");
export const DeleteTokenField = z.string().regex(idPattern(ID_PREFIXES.delete), "must be a delete_token previously returned by this server");
export const Sha256Field = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase 64-character hex SHA-256 digest");

export const MimeCategorySchema = z.enum(["text", "pdf", "image", "office", "archive", "unknown"]);

// Wire shapes are deliberately snake_case throughout — matching every tool
// *input* field (file_id, declared_size_bytes, processor_id, delete_token,
// ...) and the other result schemas below. The internal TypeScript types in
// src/lib/store.ts (FileRecord, JobRecord, DeleteTicket) stay camelCase —
// that's an unrelated, purely internal convention — so every place that
// returns one of these as `structuredContent` goes through the `toWire*()`
// mappers in src/lib/wire.ts rather than spreading the internal record
// directly onto the wire.
export const FileRecordSchema = z.object({
  file_id: z.string(),
  filename: z.string(),
  size_bytes: z.number().int().nonnegative(),
  mime_category: MimeCategorySchema,
  sha256: z.string(),
  created_at: z.string(),
  pending_delete: z.boolean(),
});

export const JobRecordSchema = z.object({
  job_id: z.string(),
  file_id: z.string(),
  processor_id: z.string(),
  options: z.record(z.string(), z.unknown()).optional(),
  state: z.enum(["prepared", "completed", "failed"]),
  created_at: z.string(),
  completed_at: z.string().optional(),
  error: z.string().optional(),
});

export const CapabilitiesSchema = z.object({
  product_slug: z.string(),
  product_version: z.string(),
  state_schema_version: z.number().int().positive(),
  mcp_protocol_version: z.string(),
  package_profile: z.string(),
  audit_profile: z.string(),
  health_profile: z.string(),
  audit_mode: z.enum(["off", "hub"]),
  limits: z.object({
    max_upload_bytes: z.number().int().positive(),
    allowed_mime_categories: z.array(z.string()),
    rate_limit_window_ms: z.number().int().positive(),
    rate_limits_per_window: z.object({
      read: z.number().int().positive(),
      write: z.number().int().positive(),
      critical: z.number().int().positive(),
    }),
  }),
  processors: z.array(z.object({ id: z.string(), supported_mime_categories: z.array(MimeCategorySchema) })),
  // Redundant with the server's initialize-time `instructions` (see
  // server.ts) on purpose: some MCP clients don't forward `instructions`
  // into the model's context, but a tool explicitly called and its result
  // read back is reliably seen — this is the belt to that suspenders.
  usage: z.array(z.string()),
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

export const FileVerifyResultSchema = FileRecordSchema.extend({
  actual_sha256: z.string(),
  matches: z.boolean(),
});

export const DuplicateCheckResultSchema = z.object({
  sha256: z.string(),
  duplicates: z.array(FileRecordSchema),
});

/** Exactly one of file_id/sha256 must be given — checking "does this file
 * I already have have duplicates" (file_id) and "does this exact content
 * already exist, e.g. before I even upload it" (sha256) are the two real
 * use cases; giving both or neither has no well-defined meaning. */
export const DuplicateCheckInputSchema = z
  .object({ file_id: FileIdField.optional(), sha256: Sha256Field.optional() })
  .refine((v) => (v.file_id ? !v.sha256 : !!v.sha256), { message: "provide exactly one of file_id or sha256" });

export const KnowledgeHandoffResultSchema = z.object({
  target: z.literal("knowledge"),
  source: z.object({
    file_id: z.string(),
    sha256: z.string(),
    mime_category: z.string(),
    original_filename: z.string(),
  }),
  contribution: z.object({
    topic: z.string().nullable(),
    department: z.string().nullable(),
    scope: z.string().nullable(),
    answers: z.array(z.object({ question: z.string(), answer: z.string() })),
    statements: z.array(z.object({ text: z.string() })),
  }),
  requires_user_input: z.array(z.string()),
  warnings: z.array(z.string()),
  ready: z.boolean(),
});

export const JobResultEnvelopeSchema = z.object({
  job_id: z.string(),
  result: z.record(z.string(), z.unknown()),
});

export const JobListResultSchema = z.object({
  jobs: z.array(JobRecordSchema),
  next_cursor: z.string().optional(),
});

export const DeleteTicketResultSchema = z.object({
  delete_token: z.string(),
  file_id: z.string(),
  created_at: z.string(),
});

export const DownloadPrepareResultSchema = z.object({
  download_token: z.string(),
  download_url: z.string(),
  expires_at: z.string(),
});

export const HealthSchema = z.object({
  health_profile: z.string(),
  product_version: z.string(),
  state_schema_version: z.number().int().positive(),
  status: z.enum(["ok", "degraded"]),
  control_plane_reachable: z.literal(true),
  data_plane_reachable: z.boolean(),
  staging_dir_writable: z.boolean(),
  files_dir_writable: z.boolean(),
  processor_registry: z.object({ processor_count: z.number().int().nonnegative() }),
  jobs: z.object({
    prepared: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  storage: z.object({
    file_count: z.number().int().nonnegative(),
    total_bytes: z.number().int().nonnegative(),
    staging_file_count: z.number().int().nonnegative(),
    // partialRecord, not record: only mime categories that actually have at
    // least one file present are keys — most instances will never see an
    // "archive" file, and a plain z.record(enum, ...) would require every
    // enum member as a key (Output validation error caught this live).
    by_mime_category: z.partialRecord(MimeCategorySchema, z.object({
      count: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
    })),
  }),
  audit: z.object({
    mode: z.enum(["off", "hub"]),
    endpoint_configured: z.boolean().optional(),
    service_id_configured: z.boolean().optional(),
    credential_path_configured: z.boolean().optional(),
    hub_endpoint_reachable: z.boolean().optional(),
    hub_service_healthy: z.boolean().optional(),
  }),
});
