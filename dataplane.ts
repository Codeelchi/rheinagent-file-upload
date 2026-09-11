console.log("Starting RheinAgent File Upload data plane...");

import express from "express";
import fs from "node:fs";
import { getPendingUpload, stagingPath, ensureDirs } from "./src/lib/store.js";
import { MAX_UPLOAD_BYTES } from "./src/lib/security.js";

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

const PORT = Number(process.env.RHEINAGENT_FILE_UPLOAD_DATAPLANE_PORT ?? 3902);
app.listen(PORT, () => {
  console.log(`Data plane listening on http://localhost:${PORT}`);
});
