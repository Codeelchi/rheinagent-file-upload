console.log("Starting RheinAgent File Upload MCP control plane (protocol 2026-07-28)...");

import {
  McpServer,
  createMcpHandler,
  inputRequired,
  acceptedContent,
  type ServerContext,
  type CallToolResult,
  type InputRequiredResult,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import express from "express";
import fs from "node:fs/promises";
import { z } from "zod";

import { getCapabilities, HEALTH_PROFILE, USAGE_STEPS } from "./src/lib/capabilities.js";
import { auditInvocation, auditCriticalWrite, loadAuditConfig, checkHubEndpointReachable } from "./src/lib/audit.js";
import {
  ensureDirs,
  createPendingUpload,
  getPendingUpload,
  consumePendingUpload,
  stagingPath,
  finalizeFile,
  listFilesPage,
  getFile,
  filePath,
  createDownloadTicket,
  createDeleteTicket,
  applyDelete,
  createJob,
  getJob,
  listJobsPage,
  updateJob,
  writeJobResult,
  readJobResult,
  checkStagingDirWritable,
  checkFilesDirWritable,
  sweepOrphanedStaging,
  renameFile,
  getStorageStats,
  verifyFile,
  findFilesBySha256,
} from "./src/lib/store.js";
import { buildKnowledgeHandoffProposal } from "./src/lib/knowledgeHandoff.js";
import { classifyExtension, sniffMimeCategory, sha256Hex, MAX_UPLOAD_BYTES } from "./src/lib/security.js";
import { getProcessor, listProcessorIds, processorSupportsMimeCategory } from "./src/lib/processors.js";
import { checkRateLimit, RateLimitExceededError, type WeightClass } from "./src/lib/rateLimit.js";
import { createLogger } from "./src/lib/logging.js";
import {
  FileRecordSchema,
  JobRecordSchema,
  CapabilitiesSchema,
  UploadPrepareResultSchema,
  FileListResultSchema,
  FileViewResultSchema,
  FileVerifyResultSchema,
  DuplicateCheckResultSchema,
  DuplicateCheckInputSchema,
  KnowledgeHandoffResultSchema,
  JobResultEnvelopeSchema,
  DeleteTicketResultSchema,
  DownloadPrepareResultSchema,
  HealthSchema,
  JobListResultSchema,
  MimeCategorySchema,
  FileIdField,
  JobIdField,
  UploadIdField,
  DeleteTokenField,
} from "./src/lib/schemas.js";
import { toWireFile, toWireJob, toWireDeleteTicket } from "./src/lib/wire.js";

const logger = createLogger("rheinagent-file-upload.control-plane");

// Inline content is only returned for small, text-category files. Anything
// larger stays on the data plane — this keeps large binaries out of MCP
// JSON entirely, per the architecture brief.
const INLINE_CONTENT_MAX_BYTES = 64 * 1024;

// Where the control plane reaches the data plane — both for its own
// internal health-reachability check and for the upload_url/download_url
// handed back to an MCP client. Defaults match the pre-2026-09-11
// single-host assumption (both processes on the same box, "localhost").
// RHEINAGENT_FILE_UPLOAD_DATAPLANE_HOST exists for split-container/
// split-host deployments (see docker-compose.yml) where the data plane
// isn't reachable via "localhost" from the control plane's own network
// namespace, and/or an external MCP client needs a different hostname
// than the one the control plane itself would use.
const DATAPLANE_HOST = process.env.RHEINAGENT_FILE_UPLOAD_DATAPLANE_HOST ?? "localhost";
const DATAPLANE_PORT = process.env.RHEINAGENT_FILE_UPLOAD_DATAPLANE_PORT ?? "3902";
const DATAPLANE_BASE_URL = `http://${DATAPLANE_HOST}:${DATAPLANE_PORT}`;

type ToolReturn = CallToolResult | InputRequiredResult;

/**
 * Wraps every tool handler with rate limiting (MCP spec: servers MUST rate
 * limit tool invocations) and structured logging, so individual handlers
 * below stay focused on business logic. Limiting is per-tool-name, not
 * per-client — see src/lib/rateLimit.ts for why that's the right
 * granularity under the stateless 2026-07-28 model.
 */
function guarded<A>(
  toolName: string,
  weightClass: WeightClass,
  handler: (args: A, ctx: ServerContext) => Promise<ToolReturn>,
) {
  return async (args: A, ctx: ServerContext): Promise<ToolReturn> => {
    try {
      checkRateLimit(toolName, weightClass);
    } catch (err) {
      if (err instanceof RateLimitExceededError) {
        logger.warning(`rate limit exceeded`, { tool: toolName, weight_class: weightClass });
        return { content: [{ type: "text", text: err.message }], isError: true };
      }
      throw err;
    }
    try {
      return await handler(args, ctx);
    } catch (err) {
      logger.error(`tool handler threw`, { tool: toolName });
      return { content: [{ type: "text", text: `internal error in ${toolName}: ${err}` }], isError: true };
    }
  };
}

function registerTools(server: McpServer): void {
  server.registerTool(
    "rheinagent_file_capabilities_get",
    {
      title: "Capabilities",
      description: "Returns protocol version, package/audit/health profiles, limits and registered processors.",
      inputSchema: z.object({}),
      outputSchema: CapabilitiesSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded("rheinagent_file_capabilities_get", "read", async () => {
      await auditInvocation("rheinagent_file_capabilities_get");
      const caps = getCapabilities();
      return { content: [{ type: "text", text: JSON.stringify(caps) }], structuredContent: caps };
    }),
  );

  server.registerTool(
    "rheinagent_file_health_get",
    {
      title: "Health / doctor check",
      description:
        "Checks control/data-plane reachability, staging/files directory writability, current storage usage (file count, total bytes, staged-file count, breakdown by mime_category), and (if audit_mode=hub) audit config completeness and best-effort Hub network reachability. Never returns file contents, hashes, or audit credentials.",
      inputSchema: z.object({}),
      outputSchema: HealthSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    guarded("rheinagent_file_health_get", "read", async () => {
      const dataPlaneReachable = await fetch(`${DATAPLANE_BASE_URL}/healthz`, {
        signal: AbortSignal.timeout(2000),
      })
        .then((res) => res.ok)
        .catch(() => false);

      const [stagingWritable, filesWritable, storage] = await Promise.all([
        checkStagingDirWritable(),
        checkFilesDirWritable(),
        getStorageStats(),
      ]);

      const auditCfg = loadAuditConfig();
      const audit: Record<string, unknown> = { mode: auditCfg.mode };
      if (auditCfg.mode === "hub") {
        audit.endpoint_configured = Boolean(auditCfg.endpoint);
        audit.service_id_configured = Boolean(auditCfg.serviceId);
        audit.credential_path_configured = Boolean(auditCfg.credentialPath);
        audit.hub_endpoint_reachable = await checkHubEndpointReachable(auditCfg);
      }

      const healthy =
        dataPlaneReachable &&
        stagingWritable &&
        filesWritable &&
        (auditCfg.mode === "off" || audit.hub_endpoint_reachable !== false);

      const body = {
        health_profile: HEALTH_PROFILE,
        status: healthy ? ("ok" as const) : ("degraded" as const),
        control_plane_reachable: true as const,
        data_plane_reachable: dataPlaneReachable,
        staging_dir_writable: stagingWritable,
        files_dir_writable: filesWritable,
        storage: {
          file_count: storage.fileCount,
          total_bytes: storage.totalBytes,
          staging_file_count: storage.stagingFileCount,
          by_mime_category: storage.byMimeCategory,
        },
        audit,
      };
      await auditInvocation("rheinagent_file_health_get", { status: body.status });
      return {
        content: [{ type: "text", text: `status: ${body.status}` }],
        structuredContent: body,
      };
    }),
  );

  server.registerTool(
    "rheinagent_file_upload_prepare",
    {
      title: "Prepare file upload",
      description:
        "Declares an intended upload (filename, declared size) and returns an opaque upload_id plus the data-plane URL to PUT the raw bytes to. No file bytes are exchanged via MCP JSON.",
      inputSchema: z.object({ filename: z.string().min(1), declared_size_bytes: z.number().int().positive() }),
      outputSchema: UploadPrepareResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded("rheinagent_file_upload_prepare", "write", async ({ filename, declared_size_bytes }) => {
      if (declared_size_bytes > MAX_UPLOAD_BYTES) {
        return { content: [{ type: "text", text: `declared_size_bytes exceeds max_upload_bytes (${MAX_UPLOAD_BYTES})` }], isError: true };
      }
      if (classifyExtension(filename) === null) {
        return { content: [{ type: "text", text: `extension of "${filename}" is not allowed` }], isError: true };
      }
      const pending = await createPendingUpload(filename, declared_size_bytes);
      await auditInvocation("rheinagent_file_upload_prepare", {
        mime_category: classifyExtension(filename) ?? "unknown",
        declared_size_bytes,
      });
      const body = {
        upload_id: pending.uploadId,
        upload_url: `${DATAPLANE_BASE_URL}/upload/${pending.uploadId}`,
        expires_at: pending.expiresAt,
      };
      return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
    }),
  );

  server.registerTool(
    "rheinagent_file_upload_finalize",
    {
      title: "Finalize file upload",
      description:
        "Validates the staged bytes for a previously prepared upload_id (size, magic-byte sniff vs declared extension, hash) and atomically moves them into accepted storage.",
      inputSchema: z.object({ upload_id: UploadIdField }),
      outputSchema: FileRecordSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded("rheinagent_file_upload_finalize", "critical", async ({ upload_id }) => {
      const pending = await getPendingUpload(upload_id);
      if (!pending) {
        return { content: [{ type: "text", text: "upload_id unknown or expired" }], isError: true };
      }
      const staged = await stagingPath(upload_id);
      let buf: Buffer;
      try {
        buf = await fs.readFile(staged);
      } catch {
        return { content: [{ type: "text", text: "no staged bytes found for this upload_id (PUT to upload_url first)" }], isError: true };
      }

      const declaredCategory = classifyExtension(pending.declaredFilename);
      const sniffedCategory = sniffMimeCategory(buf);
      if (declaredCategory === null || sniffedCategory !== declaredCategory) {
        await fs.unlink(staged).catch(() => {});
        await consumePendingUpload(upload_id);
        return {
          content: [{ type: "text", text: `rejected: declared extension category "${declaredCategory}" does not match sniffed content "${sniffedCategory}"` }],
          isError: true,
        };
      }
      if (buf.length > MAX_UPLOAD_BYTES) {
        await fs.unlink(staged).catch(() => {});
        await consumePendingUpload(upload_id);
        return { content: [{ type: "text", text: "rejected: staged bytes exceed max_upload_bytes" }], isError: true };
      }

      const sha256 = sha256Hex(buf);
      const record = await auditCriticalWrite(
        {
          action: "file.upload.finalize",
          classification: "WRITE",
          allowedMetadataKeys: ["mime_category", "final_size_bytes"],
          metadata: { mime_category: sniffedCategory, final_size_bytes: buf.length },
        },
        () => finalizeFile(upload_id, { filename: pending.declaredFilename, sizeBytes: buf.length, mimeCategory: sniffedCategory, sha256 }),
      );
      await consumePendingUpload(upload_id);
      logger.notice("file accepted", { tool: "rheinagent_file_upload_finalize" });

      return {
        content: [{ type: "text", text: `"${record.filename}" accepted as ${record.fileId} (${record.sizeBytes} bytes).` }],
        structuredContent: toWireFile(record),
      };
    }),
  );

  server.registerTool(
    "rheinagent_file_list",
    {
      title: "List files",
      description:
        "Lists accepted files (metadata only), optionally filtered by mime_category and/or a case-insensitive filename_contains substring, paginated via cursor/next_cursor. Filtering happens before pagination.",
      inputSchema: z.object({
        mime_category: MimeCategorySchema.optional(),
        filename_contains: z.string().min(1).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
      }),
      outputSchema: FileListResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded("rheinagent_file_list", "read", async ({ mime_category, filename_contains, cursor, limit }) => {
      const page = await listFilesPage({ mimeCategory: mime_category, filenameContains: filename_contains }, cursor, limit);
      await auditInvocation("rheinagent_file_list", { result_count: page.files.length });
      const body = { files: page.files.map(toWireFile), next_cursor: page.nextCursor };
      return { content: [{ type: "text", text: `${page.files.length} file(s).` }], structuredContent: body };
    }),
  );

  server.registerTool(
    "rheinagent_file_get",
    {
      title: "Get file metadata (and small text content inline)",
      description:
        "Returns metadata for a file_id. For small text-category files, content is inlined; larger or binary files are metadata-only — use rheinagent_file_download_prepare to fetch those via the data plane, not MCP JSON.",
      inputSchema: z.object({ file_id: FileIdField }),
      outputSchema: FileViewResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded("rheinagent_file_get", "read", async ({ file_id }) => {
      const record = await getFile(file_id);
      if (!record) return { content: [{ type: "text", text: `file ${file_id} not found` }], isError: true };
      await auditInvocation("rheinagent_file_get");
      let content: string | undefined;
      if (record.mimeCategory === "text" && record.sizeBytes <= INLINE_CONTENT_MAX_BYTES) {
        content = await fs.readFile(await filePath(file_id), "utf-8");
      }
      const body = { ...toWireFile(record), content };
      return {
        content: [{ type: "text", text: content ?? `${record.filename} (${record.sizeBytes} bytes, ${record.mimeCategory})` }],
        structuredContent: body,
      };
    }),
  );

  server.registerTool(
    "rheinagent_file_rename",
    {
      title: "Rename a file",
      description:
        "Changes a file's display filename. The new filename's extension must still classify to the same mime_category as the file's already-validated bytes (e.g. a file accepted as \"text\" can be renamed between .txt/.md/.csv/.json, but never to .pdf) — a rename that would change the effective category is rejected.",
      inputSchema: z.object({ file_id: FileIdField, new_filename: z.string().min(1) }),
      outputSchema: FileRecordSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded("rheinagent_file_rename", "write", async ({ file_id, new_filename }) => {
      try {
        const record = await renameFile(file_id, new_filename);
        await auditInvocation("rheinagent_file_rename", { mime_category: record.mimeCategory });
        return {
          content: [{ type: "text", text: `${file_id} renamed to "${record.filename}".` }],
          structuredContent: toWireFile(record),
        };
      } catch (err) {
        return { content: [{ type: "text", text: String(err) }], isError: true };
      }
    }),
  );

  server.registerTool(
    "rheinagent_file_verify",
    {
      title: "Verify file integrity",
      description:
        "Re-reads a file's bytes from disk and recomputes its SHA-256, comparing against the hash recorded at upload time. Detects disk corruption or out-of-band changes to data/files/ that upload_finalize's one-time check can't catch. Read-only — makes no changes regardless of the outcome.",
      inputSchema: z.object({ file_id: FileIdField }),
      outputSchema: FileVerifyResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded("rheinagent_file_verify", "read", async ({ file_id }) => {
      try {
        const { record, actualSha256, matches } = await verifyFile(file_id);
        await auditInvocation("rheinagent_file_verify", { matches });
        const body = { ...toWireFile(record), actual_sha256: actualSha256, matches };
        // Not isError on a mismatch, same convention as rheinagent_file_health_get's
        // "degraded" status: the tool ran successfully and reported a true
        // negative finding — isError is for the tool call itself failing,
        // not for domain data the caller needs to read from `matches`.
        return {
          content: [{ type: "text", text: matches ? `${file_id}: sha256 matches.` : `${file_id}: SHA-256 MISMATCH — recorded ${record.sha256}, actual ${actualSha256}` }],
          structuredContent: body,
        };
      } catch (err) {
        return { content: [{ type: "text", text: String(err) }], isError: true };
      }
    }),
  );

  server.registerTool(
    "rheinagent_file_duplicate_check",
    {
      title: "Check for duplicate file content",
      description:
        "Looks up every already-accepted file whose SHA-256 matches the given one, using the hash already recorded at upload_finalize time. Pass either file_id (checks that file's own hash against every other accepted file, excluding itself) or sha256 directly (e.g. to check before uploading whether this exact content already exists). Read-only — never deletes, merges, or otherwise changes anything; the caller decides what a duplicate finding means for their workflow.",
      inputSchema: DuplicateCheckInputSchema,
      outputSchema: DuplicateCheckResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded("rheinagent_file_duplicate_check", "read", async ({ file_id, sha256 }) => {
      try {
        let targetSha256 = sha256;
        let excludeFileId: string | undefined;
        if (file_id) {
          const record = await getFile(file_id);
          if (!record || record.pendingDelete) {
            return { content: [{ type: "text", text: `file not found: ${file_id}` }], isError: true };
          }
          targetSha256 = record.sha256;
          excludeFileId = file_id;
        }
        const duplicates = await findFilesBySha256(targetSha256!, excludeFileId);
        await auditInvocation("rheinagent_file_duplicate_check", { duplicate_count: duplicates.length });
        return {
          content: [{ type: "text", text: duplicates.length === 0 ? "no duplicates found." : `${duplicates.length} duplicate(s) found.` }],
          structuredContent: { sha256: targetSha256!, duplicates: duplicates.map(toWireFile) },
        };
      } catch (err) {
        return { content: [{ type: "text", text: String(err) }], isError: true };
      }
    }),
  );

  server.registerTool(
    "rheinagent_file_knowledge_handoff_prepare",
    {
      title: "Prepare a Knowledge contribution proposal",
      description:
        "Builds a proposal shaped for rheinagent-knowledge-mcp's own knowledge_contribution_create tool ({topic, department, scope, answers, statements}) from an accepted file and (optionally) an already-completed extraction job's text result. This does NOT call Knowledge and does NOT publish anything — it never bypasses Knowledge's own contribution/review/publish flow. department and scope always come back null with an entry in requires_user_input: this product has no Knowledge tenant identity and cannot know which data scopes the calling principal has been granted there, so it never invents one. Pass extraction_job_id (a completed job for this file, e.g. from text_extract/docx_extract_text/pdf_extract_text) to include its text as statements; without it the proposal carries no content and a warning explains why.",
      inputSchema: z.object({ file_id: FileIdField, extraction_job_id: JobIdField.optional() }),
      outputSchema: KnowledgeHandoffResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded("rheinagent_file_knowledge_handoff_prepare", "read", async ({ file_id, extraction_job_id }) => {
      try {
        const file = await getFile(file_id);
        if (!file || file.pendingDelete) {
          return { content: [{ type: "text", text: `file not found: ${file_id}` }], isError: true };
        }
        let job = null;
        let jobResult: unknown = undefined;
        if (extraction_job_id) {
          job = (await getJob(extraction_job_id)) ?? null;
          if (!job || job.fileId !== file_id) {
            return { content: [{ type: "text", text: `extraction_job_id ${extraction_job_id} not found for file ${file_id}` }], isError: true };
          }
          jobResult = await readJobResult(extraction_job_id);
        }
        const proposal = buildKnowledgeHandoffProposal(file, job, jobResult);
        await auditInvocation("rheinagent_file_knowledge_handoff_prepare", { has_content: proposal.ready });
        return {
          content: [{ type: "text", text: proposal.ready ? "proposal prepared with content." : "proposal prepared without content (see warnings)." }],
          structuredContent: proposal,
        };
      } catch (err) {
        return { content: [{ type: "text", text: String(err) }], isError: true };
      }
    }),
  );

  server.registerTool(
    "rheinagent_file_download_prepare",
    {
      title: "Prepare a file download",
      description:
        "Issues a short-lived download_token and data-plane download_url for a file_id. Use this for large/binary files that rheinagent_file_get won't inline; the token is reusable until it expires (15 min).",
      inputSchema: z.object({ file_id: FileIdField }),
      outputSchema: DownloadPrepareResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded("rheinagent_file_download_prepare", "write", async ({ file_id }) => {
      try {
        const ticket = await createDownloadTicket(file_id);
        await auditInvocation("rheinagent_file_download_prepare");
        const body = {
          download_token: ticket.downloadToken,
          download_url: `${DATAPLANE_BASE_URL}/download/${ticket.downloadToken}`,
          expires_at: ticket.expiresAt,
        };
        return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
      } catch (err) {
        return { content: [{ type: "text", text: String(err) }], isError: true };
      }
    }),
  );

  server.registerTool(
    "rheinagent_file_process_prepare",
    {
      title: "Prepare a processing job",
      description:
        "Creates a job for a registered server-side processor against a file_id. Does not run the processor yet. See rheinagent_file_capabilities_get's processors list for valid processor_id values. options is an optional, processor-specific object (e.g. pdf_extract_text accepts {\"page\": N} to extract one page instead of the whole document) — most processors ignore it.",
      inputSchema: z.object({ file_id: FileIdField, processor_id: z.string(), options: z.record(z.string(), z.unknown()).optional() }),
      outputSchema: JobRecordSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded("rheinagent_file_process_prepare", "write", async ({ file_id, processor_id, options }) => {
      const record = await getFile(file_id);
      if (!record) return { content: [{ type: "text", text: `file ${file_id} not found` }], isError: true };
      if (!getProcessor(processor_id)) {
        return { content: [{ type: "text", text: `unknown processor_id. Registered: ${listProcessorIds().join(", ")}` }], isError: true };
      }
      if (!processorSupportsMimeCategory(processor_id, record.mimeCategory)) {
        return {
          content: [{
            type: "text",
            text: `processor "${processor_id}" does not support mime_category "${record.mimeCategory}" — call rheinagent_file_capabilities_get to see each processor's supported_mime_categories`,
          }],
          isError: true,
        };
      }
      const job = await createJob(file_id, processor_id, options);
      await auditInvocation("rheinagent_file_process_prepare", { processor_id });
      return { content: [{ type: "text", text: `job ${job.jobId} prepared (processor ${processor_id}).` }], structuredContent: toWireJob(job) };
    }),
  );

  server.registerTool(
    "rheinagent_file_process_apply",
    {
      title: "Apply a processing job",
      description: "Runs the registered processor for a prepared job_id and atomically stores the result.",
      inputSchema: z.object({ job_id: JobIdField }),
      outputSchema: JobResultEnvelopeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded("rheinagent_file_process_apply", "critical", async ({ job_id }) => {
      const job = await getJob(job_id);
      if (!job) return { content: [{ type: "text", text: `job ${job_id} not found` }], isError: true };
      if (job.state !== "prepared") {
        return { content: [{ type: "text", text: `job ${job_id} is already ${job.state}` }], isError: true };
      }
      const record = await getFile(job.fileId);
      if (!record) return { content: [{ type: "text", text: `file ${job.fileId} for this job no longer exists` }], isError: true };
      const processor = getProcessor(job.processorId)!;

      try {
        const resultData = await auditCriticalWrite(
          {
            action: "file.process.apply",
            classification: "WRITE",
            allowedMetadataKeys: ["processor_id"],
            metadata: { processor_id: job.processorId },
          },
          async () => {
            const output = await processor({ filePath: await filePath(job.fileId), filename: record.filename, mimeCategory: record.mimeCategory, options: job.options });
            await writeJobResult(job_id, output);
            return output;
          },
        );
        await updateJob(job_id, { state: "completed", completedAt: new Date().toISOString() });
        const body = { job_id, result: resultData };
        return { content: [{ type: "text", text: `job ${job_id} completed.` }], structuredContent: body };
      } catch (err) {
        await updateJob(job_id, { state: "failed", completedAt: new Date().toISOString(), error: String(err) });
        return { content: [{ type: "text", text: `job ${job_id} failed: ${err}` }], isError: true };
      }
    }),
  );

  server.registerTool(
    "rheinagent_file_job_get",
    {
      title: "Get job status",
      description: "Returns the current state of a processing job.",
      inputSchema: z.object({ job_id: JobIdField }),
      outputSchema: JobRecordSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded("rheinagent_file_job_get", "read", async ({ job_id }) => {
      const job = await getJob(job_id);
      if (!job) return { content: [{ type: "text", text: `job ${job_id} not found` }], isError: true };
      await auditInvocation("rheinagent_file_job_get");
      return { content: [{ type: "text", text: `job ${job_id}: ${job.state}` }], structuredContent: toWireJob(job) };
    }),
  );

  server.registerTool(
    "rheinagent_file_job_list",
    {
      title: "List processing jobs",
      description:
        "Lists processing jobs, optionally filtered by file_id/state/processor_id, paginated via cursor/next_cursor. Use this to find a job_id again if it was lost, to see every job ever run against a file, or to find e.g. every failed job (state=\"failed\").",
      inputSchema: z.object({
        file_id: FileIdField.optional(),
        state: z.enum(["prepared", "completed", "failed"]).optional(),
        processor_id: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
      }),
      outputSchema: JobListResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded("rheinagent_file_job_list", "read", async ({ file_id, state, processor_id, cursor, limit }) => {
      const page = await listJobsPage({ fileId: file_id, state, processorId: processor_id }, cursor, limit);
      await auditInvocation("rheinagent_file_job_list", { result_count: page.jobs.length });
      const body = { jobs: page.jobs.map(toWireJob), next_cursor: page.nextCursor };
      return { content: [{ type: "text", text: `${page.jobs.length} job(s).` }], structuredContent: body };
    }),
  );

  server.registerTool(
    "rheinagent_file_result_get",
    {
      title: "Get job result",
      description: "Returns the stored result of a completed processing job.",
      inputSchema: z.object({ job_id: JobIdField }),
      outputSchema: JobResultEnvelopeSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    guarded("rheinagent_file_result_get", "read", async ({ job_id }) => {
      const result = await readJobResult(job_id);
      if (result === undefined) return { content: [{ type: "text", text: `no result for job ${job_id}` }], isError: true };
      await auditInvocation("rheinagent_file_result_get");
      const body = { job_id, result: result as Record<string, unknown> };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: body };
    }),
  );

  server.registerTool(
    "rheinagent_file_delete_prepare",
    {
      title: "Prepare file deletion",
      description: "Marks a file pending-delete and returns a delete_token. The file is not removed until delete_apply is called with this token.",
      inputSchema: z.object({ file_id: FileIdField }),
      outputSchema: DeleteTicketResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded("rheinagent_file_delete_prepare", "write", async ({ file_id }) => {
      try {
        const ticket = await createDeleteTicket(file_id);
        await auditInvocation("rheinagent_file_delete_prepare");
        return { content: [{ type: "text", text: `delete_token ${ticket.deleteToken} prepared for ${file_id}.` }], structuredContent: toWireDeleteTicket(ticket) };
      } catch (err) {
        return { content: [{ type: "text", text: String(err) }], isError: true };
      }
    }),
  );

  server.registerTool(
    "rheinagent_file_delete_apply",
    {
      title: "Apply file deletion",
      description:
        "Permanently removes the file associated with a delete_token from accepted storage. Asks for explicit confirmation before deleting (multi-round-trip elicitation) since this is a destructive, irreversible operation.",
      inputSchema: z.object({ delete_token: DeleteTokenField }),
      outputSchema: FileListResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    guarded("rheinagent_file_delete_apply", "critical", async ({ delete_token }, ctx) => {
      const confirmed = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, "confirm");
      if (!confirmed?.confirm) {
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: "This permanently deletes the file. Confirm deletion?",
              requestedSchema: {
                type: "object",
                properties: { confirm: { type: "boolean" } },
                required: ["confirm"],
              },
            }),
          },
        });
      }
      try {
        const record = await auditCriticalWrite(
          { action: "file.delete.apply", classification: "DELETE", allowedMetadataKeys: [] },
          () => applyDelete(delete_token),
        );
        logger.notice("file deleted", { tool: "rheinagent_file_delete_apply" });
        const page = await listFilesPage();
        return {
          content: [{ type: "text", text: `"${record.filename}" deleted.` }],
          structuredContent: { files: page.files.map(toWireFile), next_cursor: page.nextCursor },
        };
      } catch (err) {
        return { content: [{ type: "text", text: String(err) }], isError: true };
      }
    }),
  );
}

const expressApp = express();
// No CORS middleware, deliberately: real MCP clients (an agent process,
// curl, an MCP client library) call this server directly and never send an
// Origin header, so they are unaffected either way. The only thing a
// permissive `cors()` would enable is a malicious page open in the
// operator's local browser making cross-origin fetch() calls against
// localhost:3901 — a real attack class against unauthenticated local
// services, and something this product doesn't need to expose (see
// docs/SECURITY.md).
expressApp.use(express.json());

// Per-spec initialize-time guidance for the connecting model — seen once
// per session with no extra tool call, unlike rheinagent_file_capabilities_get's
// `usage` field (same content, kept in sync via src/lib/capabilities.ts's
// USAGE_STEPS) which only reaches the model if/when it's explicitly called.
const SERVER_INSTRUCTIONS = [
  "RheinAgent File Upload MCP: secure file upload, storage, and controlled server-side processing.",
  ...USAGE_STEPS,
].join("\n- ");

const mcpHandler = createMcpHandler(
  () => {
    const server = new McpServer(
      { name: "RheinAgent File Upload MCP", version: "0.2.0" },
      { instructions: SERVER_INSTRUCTIONS },
    );
    registerTools(server);
    return server;
  },
  {
    onerror: (err) => logger.error("mcp handler error", { message: String(err) }),
  },
);
const nodeHandler = toNodeHandler(mcpHandler);

// Cheap liveness probe for a container orchestrator/Docker HEALTHCHECK —
// deliberately NOT the same thing as the rheinagent_file_health_get MCP
// tool (which does real dependency checks: data-plane reachability,
// storage writability, audit config). This just answers "is the process
// accepting HTTP requests at all", the same shape as the data plane's own
// /healthz, so both planes have a uniform, business-logic-free liveness
// endpoint a container runtime can poll without speaking MCP JSON-RPC.
expressApp.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

expressApp.all("/mcp", (req, res) => {
  nodeHandler(req, res, req.body).catch((err) => {
    logger.error("unhandled error in /mcp handler", { message: String(err) });
    if (!res.destroyed) res.end();
  });
});

const PORT = 3901;
// Defaults to loopback-only: this product ships with no TLS/auth on either
// HTTP plane (see docs/SECURITY.md), so binding to all interfaces by
// default would expose it to the whole LAN/Tailnet. Set explicitly (e.g.
// to 0.0.0.0) only behind a reverse proxy or other access control.
const BIND_HOST = process.env.RHEINAGENT_FILE_UPLOAD_BIND_HOST ?? "127.0.0.1";
await ensureDirs();

// Reclaims disk space from abandoned uploads (see sweepOrphanedStaging()'s
// docstring in store.ts) once at startup, then on the same cadence as the
// upload TTL so bytes from uploads that are PUT but never finalized don't
// accumulate indefinitely during a long-running process. unref()'d so this
// timer never by itself keeps the process alive.
const STAGING_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
async function runStagingSweep(): Promise<void> {
  const { removedFiles, removedEntries } = await sweepOrphanedStaging();
  if (removedFiles > 0 || removedEntries > 0) {
    logger.notice("staging sweep", { removed_files: removedFiles, removed_entries: removedEntries });
  }
}
await runStagingSweep();
setInterval(() => {
  runStagingSweep().catch((err) => logger.error("staging sweep failed", { message: String(err) }));
}, STAGING_SWEEP_INTERVAL_MS).unref();

expressApp.listen(PORT, BIND_HOST, () => {
  console.log(`Control plane listening on http://${BIND_HOST}:${PORT}/mcp`);
});
