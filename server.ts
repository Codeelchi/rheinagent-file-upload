console.log("Starting RheinAgent File Upload MCP control plane...");

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express from "express";
import fs from "node:fs/promises";
import { z } from "zod";

import { getCapabilities } from "./src/lib/capabilities.js";
import { auditInvocation, auditCriticalWrite } from "./src/lib/audit.js";
import {
  ensureDirs,
  createPendingUpload,
  getPendingUpload,
  consumePendingUpload,
  stagingPath,
  finalizeFile,
  listFiles,
  getFile,
  filePath,
  createDeleteTicket,
  applyDelete,
  createJob,
  getJob,
  updateJob,
  writeJobResult,
  readJobResult,
} from "./src/lib/store.js";
import { classifyExtension, sniffMimeCategory, sha256Hex, MAX_UPLOAD_BYTES } from "./src/lib/security.js";
import { getProcessor, listProcessorIds } from "./src/lib/processors.js";

const server = new McpServer({ name: "RheinAgent File Upload MCP", version: "0.1.0" });

// Inline content is only returned for small, text-category files. Anything
// larger stays on the data plane — this keeps large binaries out of MCP
// JSON entirely, per the architecture brief.
const INLINE_CONTENT_MAX_BYTES = 64 * 1024;

server.registerTool(
  "rheinagent_file_capabilities_get",
  {
    title: "Capabilities",
    description: "Returns protocol version, package/audit/health profiles, limits and registered processors.",
    inputSchema: {},
  },
  async () => {
    await auditInvocation("rheinagent_file_capabilities_get");
    return { content: [{ type: "text", text: JSON.stringify(getCapabilities()) }], structuredContent: getCapabilities() };
  },
);

server.registerTool(
  "rheinagent_file_upload_prepare",
  {
    title: "Prepare file upload",
    description:
      "Declares an intended upload (filename, declared size) and returns an opaque upload_id plus the data-plane URL to PUT the raw bytes to. No file bytes are exchanged via MCP JSON.",
    inputSchema: { filename: z.string().min(1), declared_size_bytes: z.number().int().positive() },
  },
  async ({ filename, declared_size_bytes }) => {
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
    const dataplanePort = process.env.RHEINAGENT_FILE_UPLOAD_DATAPLANE_PORT ?? "3902";
    const body = {
      upload_id: pending.uploadId,
      upload_url: `http://localhost:${dataplanePort}/upload/${pending.uploadId}`,
      expires_at: pending.expiresAt,
    };
    return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
  },
);

server.registerTool(
  "rheinagent_file_upload_finalize",
  {
    title: "Finalize file upload",
    description:
      "Validates the staged bytes for a previously prepared upload_id (size, magic-byte sniff vs declared extension, hash) and atomically moves them into accepted storage.",
    inputSchema: { upload_id: z.string() },
  },
  async ({ upload_id }) => {
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

    return {
      content: [{ type: "text", text: `"${record.filename}" accepted as ${record.fileId} (${record.sizeBytes} bytes).` }],
      structuredContent: { action: "uploaded", ...record },
    };
  },
);

server.registerTool(
  "rheinagent_file_list",
  { title: "List files", description: "Lists accepted files (metadata only).", inputSchema: {} },
  async () => {
    const list = await listFiles();
    await auditInvocation("rheinagent_file_list", { result_count: list.length });
    return { content: [{ type: "text", text: `${list.length} file(s).` }], structuredContent: { action: "list", files: list } };
  },
);

server.registerTool(
  "rheinagent_file_get",
  {
    title: "Get file metadata (and small text content inline)",
    description:
      "Returns metadata for a file_id. For small text-category files, content is inlined; larger or binary files are metadata-only (download via a future data-plane endpoint, not via MCP JSON).",
    inputSchema: { file_id: z.string() },
  },
  async ({ file_id }) => {
    const record = await getFile(file_id);
    if (!record) return { content: [{ type: "text", text: `file ${file_id} not found` }], isError: true };
    await auditInvocation("rheinagent_file_get");
    let content: string | undefined;
    if (record.mimeCategory === "text" && record.sizeBytes <= INLINE_CONTENT_MAX_BYTES) {
      content = await fs.readFile(await filePath(file_id), "utf-8");
    }
    return {
      content: [{ type: "text", text: content ?? `${record.filename} (${record.sizeBytes} bytes, ${record.mimeCategory})` }],
      structuredContent: { action: "view", ...record, content },
    };
  },
);

server.registerTool(
  "rheinagent_file_process_prepare",
  {
    title: "Prepare a processing job",
    description: "Creates a job for a registered server-side processor against a file_id. Does not run the processor yet.",
    inputSchema: { file_id: z.string(), processor_id: z.string() },
  },
  async ({ file_id, processor_id }) => {
    const record = await getFile(file_id);
    if (!record) return { content: [{ type: "text", text: `file ${file_id} not found` }], isError: true };
    if (!getProcessor(processor_id)) {
      return { content: [{ type: "text", text: `unknown processor_id. Registered: ${listProcessorIds().join(", ")}` }], isError: true };
    }
    const job = await createJob(file_id, processor_id);
    await auditInvocation("rheinagent_file_process_prepare", { processor_id });
    return { content: [{ type: "text", text: `job ${job.jobId} prepared (processor ${processor_id}).` }], structuredContent: { action: "job_prepared", ...job } };
  },
);

server.registerTool(
  "rheinagent_file_process_apply",
  {
    title: "Apply a processing job",
    description: "Runs the registered processor for a prepared job_id and atomically stores the result.",
    inputSchema: { job_id: z.string() },
  },
  async ({ job_id }) => {
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
          const output = await processor({ filePath: await filePath(job.fileId), filename: record.filename, mimeCategory: record.mimeCategory });
          await writeJobResult(job_id, output);
          return output;
        },
      );
      await updateJob(job_id, { state: "completed", completedAt: new Date().toISOString() });
      return { content: [{ type: "text", text: `job ${job_id} completed.` }], structuredContent: { action: "job_completed", job_id, result: resultData } };
    } catch (err) {
      await updateJob(job_id, { state: "failed", completedAt: new Date().toISOString(), error: String(err) });
      return { content: [{ type: "text", text: `job ${job_id} failed: ${err}` }], isError: true };
    }
  },
);

server.registerTool(
  "rheinagent_file_job_get",
  { title: "Get job status", description: "Returns the current state of a processing job.", inputSchema: { job_id: z.string() } },
  async ({ job_id }) => {
    const job = await getJob(job_id);
    if (!job) return { content: [{ type: "text", text: `job ${job_id} not found` }], isError: true };
    await auditInvocation("rheinagent_file_job_get");
    return { content: [{ type: "text", text: `job ${job_id}: ${job.state}` }], structuredContent: { action: "job_status", ...job } };
  },
);

server.registerTool(
  "rheinagent_file_result_get",
  { title: "Get job result", description: "Returns the stored result of a completed processing job.", inputSchema: { job_id: z.string() } },
  async ({ job_id }) => {
    const result = await readJobResult(job_id);
    if (result === undefined) return { content: [{ type: "text", text: `no result for job ${job_id}` }], isError: true };
    await auditInvocation("rheinagent_file_result_get");
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: { action: "job_result", job_id, result } };
  },
);

server.registerTool(
  "rheinagent_file_delete_prepare",
  {
    title: "Prepare file deletion",
    description: "Marks a file pending-delete and returns a delete_token. The file is not removed until delete_apply is called with this token.",
    inputSchema: { file_id: z.string() },
  },
  async ({ file_id }) => {
    try {
      const ticket = await createDeleteTicket(file_id);
      await auditInvocation("rheinagent_file_delete_prepare");
      return { content: [{ type: "text", text: `delete_token ${ticket.deleteToken} prepared for ${file_id}.` }], structuredContent: { action: "delete_prepared", ...ticket } };
    } catch (err) {
      return { content: [{ type: "text", text: String(err) }], isError: true };
    }
  },
);

server.registerTool(
  "rheinagent_file_delete_apply",
  {
    title: "Apply file deletion",
    description: "Permanently removes the file associated with a delete_token from accepted storage.",
    inputSchema: { delete_token: z.string() },
  },
  async ({ delete_token }) => {
    try {
      const record = await auditCriticalWrite(
        { action: "file.delete.apply", classification: "DELETE", allowedMetadataKeys: [] },
        () => applyDelete(delete_token),
      );
      const list = await listFiles();
      return {
        content: [{ type: "text", text: `"${record.filename}" deleted.` }],
        structuredContent: { action: "list", files: list },
      };
    } catch (err) {
      return { content: [{ type: "text", text: String(err) }], isError: true };
    }
  },
);

const expressApp = express();
expressApp.use(cors());
expressApp.use(express.json());

expressApp.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = 3901;
await ensureDirs();
expressApp.listen(PORT, () => {
  console.log(`Control plane listening on http://localhost:${PORT}/mcp`);
});
