console.log("Starting RheinAgent File Upload data plane...");

import express from "express";
import fs from "node:fs";
import { getPendingUpload, stagingPath, ensureDirs, getDownloadTicket, getFile, filePath } from "./src/lib/store.js";
import { MAX_UPLOAD_BYTES, type MimeCategory } from "./src/lib/security.js";

/**
 * Upload data plane — deliberately separate process/port from the MCP
 * control plane (server.ts). Raw file bytes never travel through MCP
 * JSON-RPC; a client calls rheinagent_file_upload_prepare on the control
 * plane to get an upload_id, then PUTs the actual bytes here, then calls
 * rheinagent_file_upload_finalize on the control plane to validate and
 * accept the staged bytes.
 *
 * This process holds no MCP tool surface and no audit/license logic at
 * all — it only ever writes to the staging directory under a size limit.
 * All business/security validation of the staged bytes happens in
 * server.ts's upload_finalize handler, not here.
 */

await ensureDirs();

const app = express();

// Cheap liveness probe for the control plane's rheinagent_file_health_get
// tool (data_plane_reachable) — no auth, no filesystem access, no
// information beyond "this process is up".
app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.put("/upload/:uploadId", async (req, res) => {
  const { uploadId } = req.params;
  const pending = await getPendingUpload(uploadId).catch(() => undefined);
  if (!pending) {
    res.status(404).json({ error: "unknown or expired upload_id" });
    return;
  }

  const dest = await stagingPath(uploadId);
  const writeStream = fs.createWriteStream(dest, { flags: "wx" });
  let received = 0;
  let aborted = false;

  req.on("data", (chunk: Buffer) => {
    if (aborted) return;
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES) {
      aborted = true;
      writeStream.destroy();
      fs.promises.unlink(dest).catch(() => {});
      res.status(413).json({ error: "upload exceeds max_upload_bytes" });
      req.destroy();
    }
  });

  req.pipe(writeStream);

  writeStream.on("finish", () => {
    if (aborted) return;
    res.status(200).json({ upload_id: uploadId, received_bytes: received });
  });

  writeStream.on("error", (err) => {
    if (aborted) return;
    res.status(500).json({ error: String(err) });
  });
});

const CONTENT_TYPE_BY_CATEGORY: Record<MimeCategory, string> = {
  text: "text/plain; charset=utf-8",
  pdf: "application/pdf",
  image: "application/octet-stream", // exact image subtype isn't tracked; stays generic/safe
  office: "application/octet-stream", // covers both docx/xlsx; stays generic/safe
  archive: "application/octet-stream",
  unknown: "application/octet-stream",
};

/**
 * Download path, mirroring /upload/:uploadId: a client first calls
 * rheinagent_file_download_prepare on the control plane to get a
 * download_token, then GETs the bytes here. Only ever serves files already
 * accepted into data/files/<file_id> — never staging, and never a path
 * derived from anything client-supplied (filePath() re-validates the
 * opaque file_id via assertOpaqueId + safeJoin).
 */
app.get("/download/:downloadToken", async (req, res) => {
  const { downloadToken } = req.params;
  const ticket = await getDownloadTicket(downloadToken).catch(() => undefined);
  if (!ticket) {
    res.status(404).json({ error: "unknown or expired download_token" });
    return;
  }

  const record = await getFile(ticket.fileId);
  if (!record || record.pendingDelete) {
    res.status(410).json({ error: "file no longer available" });
    return;
  }

  const target = await filePath(ticket.fileId);
  res.setHeader("Content-Type", CONTENT_TYPE_BY_CATEGORY[record.mimeCategory]);
  res.setHeader("Content-Length", String(record.sizeBytes));
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(record.filename)}"`,
  );

  const readStream = fs.createReadStream(target);
  readStream.on("error", (err) => {
    if (!res.headersSent) res.status(500).json({ error: String(err) });
    else res.destroy();
  });
  readStream.pipe(res);
});

const PORT = Number(process.env.RHEINAGENT_FILE_UPLOAD_DATAPLANE_PORT ?? 3902);
// Same loopback-only default and reasoning as the control plane — see
// server.ts and docs/SECURITY.md.
const BIND_HOST = process.env.RHEINAGENT_FILE_UPLOAD_BIND_HOST ?? "127.0.0.1";
app.listen(PORT, BIND_HOST, () => {
  console.log(`Data plane listening on http://${BIND_HOST}:${PORT}`);
});
