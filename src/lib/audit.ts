import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

/** Thin, content-free adapter for the central RheinAgent Audit Hub. */
export type AuditMode = "off" | "hub";
export type Classification = "READ" | "PREPARE" | "WRITE" | "DELETE" | "SECURITY" | "CONFIG" | "UPDATE";
export type AuditRisk = "low" | "medium" | "high";

export const AUDIT_PROFILE_ID = "rheinagent-file-upload@1";

const CRITICAL_CLASSIFICATIONS: readonly Classification[] = ["WRITE", "DELETE", "SECURITY", "CONFIG", "UPDATE"];
const SENSITIVE_KEY_PATTERNS = [
  "password", "passwd", "secret", "token", "authorization", "auth_header",
  "cookie", "session_key", "api_key", "apikey", "credential", "private_key",
  "body", "content", "prompt", "completion", "draft_text", "attachment_text",
  "subject", "recipient", "html", "payload", "message_text", "document_text",
  "filename", "path", "filecontent",
] as const;

export interface AuditActionSpec {
  action: string;
  classification: Classification;
  risk: AuditRisk;
  writeAhead: boolean;
  sensitive?: boolean;
  targetType: string;
  allowedMetadataKeys: readonly string[];
}

/**
 * Runtime mirror of audit/rheinagent-file-upload-v1.json.
 * test/audit-profile.test.ts makes manifest drift a release gate.
 */
export const AUDIT_ACTIONS = {
  rheinagent_file_capabilities_get: { action: "file.capabilities.read", classification: "READ", risk: "low", writeAhead: false, targetType: "service", allowedMetadataKeys: [] },
  rheinagent_file_health_get: { action: "file.health.read", classification: "READ", risk: "low", writeAhead: false, targetType: "service", allowedMetadataKeys: ["status"] },
  rheinagent_file_upload_prepare: { action: "file.upload.prepare", classification: "PREPARE", risk: "low", writeAhead: false, targetType: "file", allowedMetadataKeys: ["mime_category", "declared_size_bytes"] },
  rheinagent_file_upload_finalize: { action: "file.upload.finalize", classification: "WRITE", risk: "high", writeAhead: true, targetType: "file", allowedMetadataKeys: ["mime_category", "final_size_bytes", "verification_result"] },
  rheinagent_file_list: { action: "file.list", classification: "READ", risk: "low", writeAhead: false, targetType: "file-index", allowedMetadataKeys: ["result_count"] },
  rheinagent_file_get: { action: "file.read", classification: "READ", risk: "medium", writeAhead: false, sensitive: true, targetType: "file", allowedMetadataKeys: [] },
  rheinagent_file_rename: { action: "file.rename", classification: "WRITE", risk: "medium", writeAhead: true, targetType: "file", allowedMetadataKeys: ["mime_category", "verification_result"] },
  rheinagent_file_verify: { action: "file.verify", classification: "READ", risk: "medium", writeAhead: false, targetType: "file", allowedMetadataKeys: ["matches"] },
  rheinagent_file_duplicate_check: { action: "file.duplicate.check", classification: "READ", risk: "medium", writeAhead: false, targetType: "file-index", allowedMetadataKeys: ["duplicate_count"] },
  rheinagent_file_knowledge_handoff_prepare: { action: "file.knowledge.handoff.prepare", classification: "PREPARE", risk: "medium", writeAhead: false, sensitive: true, targetType: "file", allowedMetadataKeys: ["has_content"] },
  rheinagent_file_download_prepare: { action: "file.download.prepare", classification: "PREPARE", risk: "medium", writeAhead: false, sensitive: true, targetType: "file", allowedMetadataKeys: [] },
  rheinagent_file_process_prepare: { action: "file.process.prepare", classification: "PREPARE", risk: "low", writeAhead: false, targetType: "job", allowedMetadataKeys: ["processor_id"] },
  rheinagent_file_process_apply: { action: "file.process.apply", classification: "WRITE", risk: "high", writeAhead: true, targetType: "job", allowedMetadataKeys: ["processor_id", "verification_result"] },
  rheinagent_file_job_get: { action: "file.job.read", classification: "READ", risk: "low", writeAhead: false, targetType: "job", allowedMetadataKeys: [] },
  rheinagent_file_job_list: { action: "file.job.list", classification: "READ", risk: "low", writeAhead: false, targetType: "job-index", allowedMetadataKeys: ["result_count"] },
  rheinagent_file_result_get: { action: "file.result.read", classification: "READ", risk: "medium", writeAhead: false, sensitive: true, targetType: "job-result", allowedMetadataKeys: [] },
  rheinagent_file_delete_prepare: { action: "file.delete.prepare", classification: "PREPARE", risk: "medium", writeAhead: false, targetType: "file", allowedMetadataKeys: [] },
  rheinagent_file_delete_apply: { action: "file.delete.apply", classification: "DELETE", risk: "high", writeAhead: true, targetType: "file", allowedMetadataKeys: ["verification_result"] },
} as const satisfies Record<string, AuditActionSpec>;

export type AuditToolName = keyof typeof AUDIT_ACTIONS;

export interface AuditConfig {
  mode: AuditMode;
  endpoint?: string;
  serviceId?: string;
  credentialPath?: string;
  protocolVersion: string;
  allowPrivateHttp: boolean;
}

export interface AllowlistedMetadata {
  [key: string]: string | number | boolean | null;
}

export class AuditHubClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuditHubClientError";
  }
}

export class AuditHubUnavailable extends AuditHubClientError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuditHubUnavailable";
  }
}

/**
 * Raised only after the business mutation callback has completed. The caller
 * must not blindly retry or report "nothing changed": reconciliation is
 * required because the business mutation may already be durable.
 */
export class AuditIncompleteError<T = unknown> extends Error {
  readonly code = "AUDIT_INCOMPLETE";
  readonly mutationApplied = true;

  constructor(
    readonly action: string,
    readonly failedPhase: "APPLY" | "VERIFY" | "RESULT" | "RESULT_AFTER_VERIFY_FAILURE",
    readonly mutationResult: T,
    cause: unknown,
  ) {
    super(`AUDIT_INCOMPLETE: ${action} mutation completed but audit phase ${failedPhase} did not complete`, { cause });
    this.name = "AuditIncompleteError";
  }
}

/**
 * A real postcondition failed after the mutation. This is different from an
 * Audit Hub outage: the Hub receives RESULT=failure when possible.
 */
export class AuditBusinessVerificationError<T = unknown> extends Error {
  readonly code = "BUSINESS_VERIFY_FAILED";
  readonly mutationApplied = true;

  constructor(readonly action: string, readonly mutationResult: T, cause: unknown) {
    super(`BUSINESS_VERIFY_FAILED: postcondition check failed for ${action}`, { cause });
    this.name = "AuditBusinessVerificationError";
  }
}

export function loadAuditConfig(): AuditConfig {
  const mode = (process.env.RA_AUDIT_MODE ?? "off") as AuditMode;
  if (mode !== "off" && mode !== "hub") {
    throw new AuditHubClientError(`invalid RA_AUDIT_MODE "${mode}" (expected "off" or "hub")`);
  }
  return {
    mode,
    endpoint: process.env.RA_AUDIT_ENDPOINT,
    serviceId: process.env.RA_AUDIT_SERVICE_ID,
    credentialPath: process.env.RA_AUDIT_CREDENTIAL_PATH,
    protocolVersion: process.env.RA_AUDIT_PROTOCOL_VERSION ?? "rheinagent-audit/1",
    allowPrivateHttp: process.env.RA_AUDIT_ALLOW_PRIVATE_HTTP === "true",
  };
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

export function sanitizeMetadata(
  metadata: AllowlistedMetadata,
  allowedKeys: readonly string[],
): AllowlistedMetadata {
  const out: AllowlistedMetadata = {};
  let count = 0;
  for (const [key, value] of Object.entries(metadata)) {
    if (count >= 16) break;
    if (!allowedKeys.includes(key) || isSensitiveKey(key)) continue;
    out[key] = typeof value === "string" && value.length > 256 ? value.slice(0, 256) : value;
    count++;
  }
  return out;
}

function actionFor(toolName: AuditToolName): AuditActionSpec {
  return AUDIT_ACTIONS[toolName];
}

function isLoopbackHttp(url: string): boolean {
  return (
    url.startsWith("http://127.0.0.1") ||
    url.startsWith("http://localhost") ||
    url.startsWith("http://[::1]")
  );
}

function validateEndpoint(cfg: AuditConfig): string {
  if (!cfg.endpoint) throw new AuditHubClientError("RA_AUDIT_ENDPOINT not set for hub mode");
  const endpoint = cfg.endpoint.replace(/\/$/, "");
  const secure = endpoint.startsWith("https://");
  const privateHttp = endpoint.startsWith("http://") && cfg.allowPrivateHttp;
  if (!secure && !isLoopbackHttp(endpoint) && !privateHttp) {
    throw new AuditHubClientError(
      "plain HTTP Audit Hub URLs must use loopback unless RA_AUDIT_ALLOW_PRIVATE_HTTP=true",
    );
  }
  return endpoint;
}

async function readCredential(cfg: AuditConfig): Promise<string> {
  if (!cfg.credentialPath) {
    throw new AuditHubClientError("RA_AUDIT_CREDENTIAL_PATH not set for hub mode");
  }
  try {
    const credential = (await fs.readFile(cfg.credentialPath, "utf-8")).trim();
    if (!credential) throw new AuditHubClientError("RA_AUDIT_CREDENTIAL_PATH is empty");
    return credential;
  } catch (error) {
    if (error instanceof AuditHubClientError) throw error;
    throw new AuditHubClientError("RA_AUDIT_CREDENTIAL_PATH could not be read", { cause: error });
  }
}

async function hubFetch(
  cfg: AuditConfig,
  method: "GET" | "POST",
  apiPath: string,
  body?: Record<string, unknown>,
  requestId?: string,
): Promise<Record<string, unknown>> {
  const baseUrl = validateEndpoint(cfg);
  if (!cfg.serviceId) throw new AuditHubClientError("RA_AUDIT_SERVICE_ID not set for hub mode");
  const credential = await readCredential(cfg);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${apiPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${credential}`,
          "X-RA-Service-Id": cfg.serviceId,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(requestId ? { "X-RA-Request-Id": requestId } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      throw new AuditHubUnavailable("audit hub unavailable", { cause: error });
    }

    let value: unknown;
    try {
      value = await response.json();
    } catch {
      value = { error: "invalid_response" };
    }

    if (!response.ok) {
      const remoteError =
        typeof value === "object" && value !== null && "error" in value
          ? String((value as Record<string, unknown>).error)
          : "request_failed";
      if (response.status >= 500) throw new AuditHubUnavailable(remoteError);
      throw new AuditHubClientError(remoteError);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new AuditHubClientError("invalid Audit Hub response");
    }
    return value as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

/** Canonical unauthenticated liveness check. */
export async function checkHubEndpointReachable(cfg: AuditConfig): Promise<boolean | undefined> {
  if (cfg.mode !== "hub" || !cfg.endpoint) return undefined;
  let baseUrl: string;
  try {
    baseUrl = validateEndpoint(cfg);
  } catch {
    return false;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`${baseUrl}/healthz`, { method: "GET", signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Authenticated service health. In hub mode incomplete config and auth/profile
 * failures are unhealthy, not "unknown".
 */
export async function checkHubServiceHealthy(cfg: AuditConfig): Promise<boolean | undefined> {
  if (cfg.mode !== "hub") return undefined;
  if (!cfg.endpoint || !cfg.serviceId || !cfg.credentialPath) return false;
  try {
    const health = await hubFetch(cfg, "GET", "/v1/service/health");
    return health.status === "HEALTHY";
  } catch {
    return false;
  }
}

/**
 * Non-critical invocation path. Only true Hub unavailability fails open.
 * Contract/auth/profile errors propagate because silently accepting a broken
 * audit integration would hide a deployment/configuration defect.
 */
export async function auditInvocation(
  toolName: AuditToolName,
  metadata: AllowlistedMetadata = {},
): Promise<void> {
  const cfg = loadAuditConfig();
  if (cfg.mode === "off") return;
  const spec = actionFor(toolName);
  try {
    await hubFetch(
      cfg,
      "POST",
      "/v1/events/invocation",
      {
        action: spec.action,
        tool: toolName,
        metadata: sanitizeMetadata(metadata, spec.allowedMetadataKeys),
        result: "success",
      },
      randomUUID(),
    );
  } catch (error) {
    if (error instanceof AuditHubUnavailable) return;
    throw error;
  }
}

export interface CriticalWriteSpec {
  toolName: AuditToolName;
  metadata?: AllowlistedMetadata;
}

export type AuditBusinessVerifier<T> = (result: T) => Promise<AllowlistedMetadata | void>;

async function sendPhase(
  cfg: AuditConfig,
  correlationId: string,
  phase: "APPLY" | "VERIFY" | "RESULT",
  options: {
    result?: "success" | "failure" | "denied" | "cancelled";
    metadata?: AllowlistedMetadata;
    errorCategory?: string;
  } = {},
): Promise<void> {
  const body: Record<string, unknown> = { correlation_id: correlationId, phase };
  if (options.result !== undefined) body.result = options.result;
  if (options.metadata !== undefined) body.metadata = options.metadata;
  if (options.errorCategory !== undefined) body.error_category = options.errorCategory;
  await hubFetch(cfg, "POST", "/v1/events/phase", body, randomUUID());
}

/**
 * Canonical critical lifecycle:
 * durable INTENT -> business mutation -> APPLY -> postcondition -> VERIFY -> RESULT.
 *
 * - INTENT/config failures occur before mutation and therefore fail closed.
 * - Hub failure after mutation becomes AUDIT_INCOMPLETE.
 * - A failed business postcondition records RESULT=failure and surfaces a
 *   distinct BUSINESS_VERIFY_FAILED error so callers do not blindly retry.
 */
export async function auditCriticalWrite<T>(
  spec: CriticalWriteSpec,
  mutation: () => Promise<T>,
  verify?: AuditBusinessVerifier<T>,
): Promise<T> {
  const cfg = loadAuditConfig();
  if (cfg.mode === "off") return mutation();

  const action = actionFor(spec.toolName);
  if (!action.writeAhead || !CRITICAL_CLASSIFICATIONS.includes(action.classification)) {
    throw new AuditHubClientError(
      `audit action ${action.action} is not configured as a critical write-ahead action`,
    );
  }

  const metadata = sanitizeMetadata(spec.metadata ?? {}, action.allowedMetadataKeys);
  const begin = await hubFetch(
    cfg,
    "POST",
    "/v1/events/begin",
    {
      action: action.action,
      tool: spec.toolName,
      metadata,
    },
    randomUUID(),
  );

  if (
    begin.status !== "intent_durable" ||
    typeof begin.correlation_id !== "string" ||
    !begin.correlation_id
  ) {
    throw new AuditHubUnavailable(
      `durable INTENT was not acknowledged for ${action.action} (mutation not executed)`,
    );
  }
  const correlationId = begin.correlation_id;

  let result: T;
  try {
    result = await mutation();
  } catch (error) {
    await sendPhase(cfg, correlationId, "RESULT", {
      result: "failure",
      errorCategory: "unexpected_error",
    }).catch(() => {});
    throw error;
  }

  try {
    await sendPhase(cfg, correlationId, "APPLY");
  } catch (error) {
    throw new AuditIncompleteError(action.action, "APPLY", result, error);
  }

  let verificationMetadata: AllowlistedMetadata = {};
  if (verify) {
    try {
      verificationMetadata = sanitizeMetadata(
        (await verify(result)) ?? {},
        action.allowedMetadataKeys,
      );
    } catch (error) {
      try {
        await sendPhase(cfg, correlationId, "RESULT", {
          result: "failure",
          errorCategory: "validation_failed",
        });
      } catch (auditError) {
        throw new AuditIncompleteError(
          action.action,
          "RESULT_AFTER_VERIFY_FAILURE",
          result,
          auditError,
        );
      }
      throw new AuditBusinessVerificationError(action.action, result, error);
    }
  }

  if (
    action.allowedMetadataKeys.includes("verification_result") &&
    verificationMetadata.verification_result === undefined
  ) {
    verificationMetadata.verification_result = "ok";
  }

  try {
    await sendPhase(cfg, correlationId, "VERIFY", { metadata: verificationMetadata });
  } catch (error) {
    throw new AuditIncompleteError(action.action, "VERIFY", result, error);
  }

  try {
    await sendPhase(cfg, correlationId, "RESULT", {
      result: "success",
      metadata: verificationMetadata,
    });
  } catch (error) {
    throw new AuditIncompleteError(action.action, "RESULT", result, error);
  }

  return result;
}
