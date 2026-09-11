import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

/**
 * Thin client for the central RheinAgent Audit Hub (Codeelchi/rheinagent-audit).
 *
 * This module deliberately does NOT implement its own audit storage, hash
 * chain, root identity, or checkpoint engine — per ADR-013 (MCP Opt-In
 * Integration Contract), a consuming product may only contain a profile
 * manifest + thin client adapter.
 *
 * Two modes only, selected by RA_AUDIT_MODE (default "off"):
 *  - "off":  zero Hub dependency. No registration, no credential, no
 *            network calls. Every function below becomes a pure passthrough.
 *            This is the required default and must keep the product fully
 *            functional on its own.
 *  - "hub":  full write-ahead contract for critical writes (ADR-004,
 *            fail-closed): begin -> durable INTENT -> ACK -> business
 *            mutation -> APPLY -> VERIFY -> RESULT. Without the
 *            `intent_durable` ACK, the mutation callback is never invoked.
 *
 * NOTE: the "hub" path below is implemented to the documented contract
 * (rheinagent-audit docs/ARCHITECTURE.md §6, ADRs 002/004/008/013) but has
 * not been exercised against a live Hub instance yet — see
 * docs/HANDOFF.md. Treat it as implemented-but-unverified.
 */

export type AuditMode = "off" | "hub";

export type Classification =
  | "READ"
  | "PREPARE"
  | "WRITE"
  | "DELETE"
  | "SECURITY"
  | "CONFIG"
  | "UPDATE";

const CRITICAL_CLASSIFICATIONS: Classification[] = ["WRITE", "DELETE", "SECURITY", "CONFIG", "UPDATE"];

// Defense in depth: block these substrings in metadata *key names* even if a
// caller mistakenly tries to allowlist them. Content is never logged
// (content_logged is schema-fixed false, not configurable) — this list
// guards against accidentally named keys that would smell like content.
const SENSITIVE_KEY_PATTERNS = [
  "password", "passwd", "secret", "token", "authorization", "auth_header",
  "cookie", "session_key", "api_key", "apikey", "credential", "private_key",
  "body", "content", "prompt", "completion", "draft_text", "attachment_text",
  "subject", "recipient", "html", "payload", "message_text", "document_text",
  "filename", "path", "filecontent",
];

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p));
}

export interface AuditConfig {
  mode: AuditMode;
  endpoint?: string;
  serviceId?: string;
  credentialPath?: string;
  protocolVersion: string;
}

export function loadAuditConfig(): AuditConfig {
  const mode = (process.env.RA_AUDIT_MODE ?? "off") as AuditMode;
  if (mode !== "off" && mode !== "hub") {
    throw new Error(`invalid RA_AUDIT_MODE "${mode}" (expected "off" or "hub")`);
  }
  return {
    mode,
    endpoint: process.env.RA_AUDIT_ENDPOINT,
    serviceId: process.env.RA_AUDIT_SERVICE_ID,
    credentialPath: process.env.RA_AUDIT_CREDENTIAL_PATH,
    protocolVersion: process.env.RA_AUDIT_PROTOCOL_VERSION ?? "rheinagent-audit/1",
  };
}

let cachedCredential: string | undefined;
async function readCredential(cfg: AuditConfig): Promise<string> {
  if (cachedCredential) return cachedCredential;
  if (!cfg.credentialPath) throw new Error("RA_AUDIT_CREDENTIAL_PATH not set for hub mode");
  cachedCredential = (await fs.readFile(cfg.credentialPath, "utf-8")).trim();
  return cachedCredential;
}

async function hubFetch(
  cfg: AuditConfig,
  method: string,
  apiPath: string,
  body?: unknown,
  requestId?: string,
): Promise<unknown> {
  if (!cfg.endpoint || !cfg.serviceId) {
    throw new Error("RA_AUDIT_ENDPOINT / RA_AUDIT_SERVICE_ID not set for hub mode");
  }
  const credential = await readCredential(cfg);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential}`,
    "X-RA-Service-Id": cfg.serviceId,
    "Content-Type": "application/json",
  };
  if (requestId) headers["X-RA-Request-Id"] = requestId;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(new URL(apiPath, cfg.endpoint), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`audit hub ${method} ${apiPath} -> HTTP ${res.status}`);
    }
    return await res.json().catch(() => ({}));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Best-effort network reachability of RA_AUDIT_ENDPOINT for the health
 * tool — deliberately NOT a protocol-level check against a documented Hub
 * health path (the hub write-ahead contract itself is implemented but
 * unverified against a live instance, see the module docstring above; this
 * repo doesn't get to invent an unverified health-endpoint contract on
 * top of that). Sends no credential and just asks "did any HTTP response
 * come back at all" within a short timeout. Returns `undefined` when the
 * check doesn't apply (mode "off" or endpoint not configured yet).
 */
export async function checkHubEndpointReachable(cfg: AuditConfig): Promise<boolean | undefined> {
  if (cfg.mode !== "hub" || !cfg.endpoint) return undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    await fetch(cfg.endpoint, { method: "GET", signal: controller.signal });
    return true; // any response at all counts as "reachable" here
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export interface AllowlistedMetadata {
  [key: string]: string | number | boolean | null;
}

/** Drop (never throw) any metadata key outside the action's own allowlist or
 * matching a sensitive-key pattern. Mirrors the Hub's own `drop` default
 * handling (RA_AUDIT_SENSITIVE_METADATA_HANDLING=drop). */
export function sanitizeMetadata(
  metadata: AllowlistedMetadata,
  allowedKeys: readonly string[],
): AllowlistedMetadata {
  const out: AllowlistedMetadata = {};
  let count = 0;
  for (const [key, value] of Object.entries(metadata)) {
    if (count >= 16) break;
    if (!allowedKeys.includes(key)) continue;
    if (isSensitiveKey(key)) continue;
    if (typeof value === "string" && value.length > 256) {
      out[key] = value.slice(0, 256);
    } else {
      out[key] = value;
    }
    count++;
  }
  return out;
}

/** READ / invocation-only events: fail-open. Never blocks tool execution. */
export async function auditInvocation(
  toolName: string,
  metadata: AllowlistedMetadata = {},
): Promise<void> {
  const cfg = loadAuditConfig();
  if (cfg.mode === "off") return;
  try {
    await hubFetch(cfg, "POST", "/v1/events/invocation", {
      tool: toolName,
      protocol_version: cfg.protocolVersion,
      metadata,
    });
  } catch {
    // Reads/invocations degrade silently per policy (RA_AUDIT_POLICY=normal).
  }
}

export interface CriticalWriteSpec {
  action: string; // e.g. "file.upload.finalize"
  classification: Classification;
  allowedMetadataKeys: readonly string[];
  metadata?: AllowlistedMetadata;
}

/**
 * Write-ahead wrapper for critical mutations (ADR-004 fail-closed):
 *   begin -> durable INTENT -> ACK -> mutation() -> APPLY -> VERIFY -> RESULT
 *
 * In "off" mode this is a pure passthrough to `mutation()` — no Hub
 * dependency at all, per contract §3.1 ("at off: ... normal tool function
 * unchanged"). In "hub" mode, `mutation()` is only ever invoked after a
 * successful `intent_durable` ACK; any Hub failure before that ACK aborts
 * the whole operation without running `mutation()`.
 */
export async function auditCriticalWrite<T>(
  spec: CriticalWriteSpec,
  mutation: () => Promise<T>,
): Promise<T> {
  const cfg = loadAuditConfig();
  if (cfg.mode === "off") {
    return mutation();
  }
  if (!CRITICAL_CLASSIFICATIONS.includes(spec.classification)) {
    throw new Error(`classification ${spec.classification} is not a critical-write classification`);
  }
  const requestId = randomUUID();
  const metadata = sanitizeMetadata(spec.metadata ?? {}, spec.allowedMetadataKeys);

  const begin = (await hubFetch(
    cfg,
    "POST",
    "/v1/events/begin",
    { action: spec.action, classification: spec.classification, metadata, protocol_version: cfg.protocolVersion },
    requestId,
  )) as { status?: string };

  if (begin?.status !== "intent_durable") {
    throw new Error(
      `audit hub did not durably ack intent for ${spec.action} (fail-closed, mutation not executed)`,
    );
  }

  let result: T;
  try {
    result = await mutation();
  } catch (err) {
    await hubFetch(cfg, "POST", "/v1/events/phase", {
      request_id: requestId,
      phase: "RESULT",
      status: "failed",
    }, requestId).catch(() => {});
    throw err;
  }

  await hubFetch(cfg, "POST", "/v1/events/phase", { request_id: requestId, phase: "APPLY" }, requestId);
  await hubFetch(cfg, "POST", "/v1/events/phase", { request_id: requestId, phase: "VERIFY" }, requestId);
  await hubFetch(
    cfg,
    "POST",
    "/v1/events/phase",
    { request_id: requestId, phase: "RESULT", status: "success" },
    requestId,
  );

  return result;
}
