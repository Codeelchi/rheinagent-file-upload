import fs from "node:fs/promises";

const CONTROL_BASE = process.env.RHEINAGENT_FILE_UPLOAD_SMOKE_CONTROL_URL ?? "http://127.0.0.1:3901";
const DATA_BASE = process.env.RHEINAGENT_FILE_UPLOAD_SMOKE_DATA_URL ?? "http://127.0.0.1:3902";
const PROTOCOL_VERSION = "2026-07-28";
let requestId = 1;

function assert(condition, message) {
  if (!condition) throw new Error(`smoke assertion failed: ${message}`);
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function callTool(name, args = {}) {
  const body = {
    jsonrpc: "2.0",
    id: requestId++,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };

  const response = await fetch(`${CONTROL_BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": PROTOCOL_VERSION,
      "mcp-method": "tools/call",
      "mcp-name": name,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}: ${text}`);
  const payload = JSON.parse(text);
  if (payload.error) throw new Error(`${name} JSON-RPC error: ${JSON.stringify(payload.error)}`);
  const result = payload.result;
  if (result?.isError) throw new Error(`${name} tool error: ${JSON.stringify(result.content)}`);
  if (!result?.structuredContent) throw new Error(`${name} returned no structuredContent`);
  return result.structuredContent;
}

async function upload(filename, bytes) {
  const prepared = await callTool("rheinagent_file_upload_prepare", {
    filename,
    declared_size_bytes: bytes.byteLength,
  });
  assert(typeof prepared.upload_id === "string", "upload_prepare did not return upload_id");
  assert(typeof prepared.upload_url === "string", "upload_prepare did not return upload_url");

  const uploadUrl = new URL(prepared.upload_url);
  // The smoke runner is always on the same host as the two planes. Rebase
  // localhost-like advertised URLs to the explicit data-plane base so this
  // remains deterministic on hosts whose localhost resolves to IPv6 first.
  const dataBase = new URL(DATA_BASE);
  uploadUrl.protocol = dataBase.protocol;
  uploadUrl.hostname = dataBase.hostname;
  uploadUrl.port = dataBase.port;

  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
    signal: AbortSignal.timeout(15_000),
  });
  const putText = await put.text();
  if (!put.ok) throw new Error(`data-plane PUT returned HTTP ${put.status}: ${putText}`);

  return callTool("rheinagent_file_upload_finalize", { upload_id: prepared.upload_id });
}

async function download(fileId) {
  const prepared = await callTool("rheinagent_file_download_prepare", { file_id: fileId });
  const downloadUrl = new URL(prepared.download_url);
  const dataBase = new URL(DATA_BASE);
  downloadUrl.protocol = dataBase.protocol;
  downloadUrl.hostname = dataBase.hostname;
  downloadUrl.port = dataBase.port;
  const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`data-plane GET returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function assertPlanesHealthy() {
  const [control, data] = await Promise.all([
    fetchJson(`${CONTROL_BASE}/healthz`),
    fetchJson(`${DATA_BASE}/healthz`),
  ]);
  assert(control.status === "ok", "control-plane /healthz is not ok");
  assert(data.status === "ok", "data-plane /healthz is not ok");
}

async function seed(statePath) {
  await assertPlanesHealthy();

  const capabilities = await callTool("rheinagent_file_capabilities_get");
  assert(capabilities.product_slug === "rheinagent-file-upload", "unexpected product_slug");
  assert(capabilities.product_version === "0.3.0", "unexpected product_version");
  assert(Array.isArray(capabilities.processors) && capabilities.processors.length === 11, "processor registry drift");

  const marker = `runtime-smoke-${Date.now()}`;
  const text = `${marker}\n\nRheinAgent file intake persistence and Knowledge handoff smoke test.`;
  const bytes = Buffer.from(text, "utf-8");

  const first = await upload("runtime-smoke-a.txt", bytes);
  assert(first.mime_category === "text", "first upload was not classified as text");

  const beforeDuplicate = await callTool("rheinagent_file_duplicate_check", { file_id: first.file_id });
  assert(beforeDuplicate.duplicates.length === 0, "fresh unique upload unexpectedly has duplicates");

  const job = await callTool("rheinagent_file_process_prepare", {
    file_id: first.file_id,
    processor_id: "text_extract",
    options: { offset: 0, limit: 4096 },
  });
  const applied = await callTool("rheinagent_file_process_apply", { job_id: job.job_id });
  assert(applied.result.text.includes(marker), "process_apply result does not contain marker");

  const storedResult = await callTool("rheinagent_file_result_get", { job_id: job.job_id });
  assert(storedResult.result.text.includes(marker), "result_get lost extracted text");

  const handoff = await callTool("rheinagent_file_knowledge_handoff_prepare", {
    file_id: first.file_id,
    extraction_job_id: job.job_id,
  });
  assert(handoff.ready === true, "Knowledge handoff did not carry extracted content");
  assert(handoff.contribution.department === null, "Knowledge handoff invented a department");
  assert(handoff.contribution.scope === null, "Knowledge handoff invented a scope");
  assert(handoff.requires_user_input.includes("department"), "Knowledge handoff did not require department input");
  assert(handoff.requires_user_input.includes("scope"), "Knowledge handoff did not require scope input");
  assert(handoff.contribution.statements.some((statement) => statement.text.includes(marker)), "Knowledge handoff lost extracted content");

  const downloaded = await download(first.file_id);
  assert(downloaded.equals(bytes), "downloaded bytes differ from uploaded bytes");

  const second = await upload("runtime-smoke-b.txt", bytes);
  const duplicate = await callTool("rheinagent_file_duplicate_check", { file_id: first.file_id });
  assert(duplicate.duplicates.some((file) => file.file_id === second.file_id), "duplicate check did not find second identical file");

  const verified = await callTool("rheinagent_file_verify", { file_id: first.file_id });
  assert(verified.matches === true, "file_verify reported a mismatch on untouched bytes");

  const health = await callTool("rheinagent_file_health_get");
  assert(health.status === "ok", `MCP health is ${health.status}`);
  assert(health.data_plane_reachable === true, "MCP health cannot reach data plane");
  assert(health.storage.file_count >= 2, "MCP health storage count did not include smoke files");

  const state = {
    marker,
    text,
    first_file_id: first.file_id,
    second_file_id: second.file_id,
    job_id: job.job_id,
    sha256: first.sha256,
  };
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  console.log(JSON.stringify({ phase: "seed", status: "ok", first_file_id: first.file_id, second_file_id: second.file_id, job_id: job.job_id }));
}

async function verify(statePath) {
  await assertPlanesHealthy();
  const state = JSON.parse(await fs.readFile(statePath, "utf-8"));

  const file = await callTool("rheinagent_file_get", { file_id: state.first_file_id });
  assert(file.sha256 === state.sha256, "persisted file hash changed after restart");
  assert(file.content === state.text, "persisted inline text changed after restart");

  const job = await callTool("rheinagent_file_job_get", { job_id: state.job_id });
  assert(job.state === "completed", "persisted job is not completed after restart");

  const result = await callTool("rheinagent_file_result_get", { job_id: state.job_id });
  assert(result.result.text.includes(state.marker), "persisted result is missing marker after restart");

  const duplicate = await callTool("rheinagent_file_duplicate_check", { file_id: state.first_file_id });
  assert(duplicate.duplicates.some((entry) => entry.file_id === state.second_file_id), "duplicate relation disappeared after restart");

  const handoff = await callTool("rheinagent_file_knowledge_handoff_prepare", {
    file_id: state.first_file_id,
    extraction_job_id: state.job_id,
  });
  assert(handoff.ready === true, "Knowledge handoff lost content after restart");
  assert(handoff.contribution.department === null && handoff.contribution.scope === null, "Knowledge handoff authorization fields changed after restart");

  const downloaded = await download(state.first_file_id);
  assert(downloaded.equals(Buffer.from(state.text, "utf-8")), "downloaded bytes changed after restart");

  const verified = await callTool("rheinagent_file_verify", { file_id: state.first_file_id });
  assert(verified.matches === true, "file_verify failed after restart");

  const health = await callTool("rheinagent_file_health_get");
  assert(health.status === "ok", `MCP health is ${health.status} after restart`);

  console.log(JSON.stringify({ phase: "verify", status: "ok", first_file_id: state.first_file_id, job_id: state.job_id }));
}

const [phase, statePath = ".runtime-smoke-state.json"] = process.argv.slice(2);
if (phase === "seed") await seed(statePath);
else if (phase === "verify") await verify(statePath);
else throw new Error("usage: node scripts/runtime-smoke.mjs <seed|verify> [state-file]");
