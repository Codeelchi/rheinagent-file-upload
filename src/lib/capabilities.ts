import { MAX_UPLOAD_BYTES } from "./security.js";
import { listProcessorsWithCategories } from "./processors.js";
import { loadAuditConfig } from "./audit.js";
import { WINDOW_MS, LIMITS } from "./rateLimit.js";

export const PRODUCT_SLUG = "rheinagent-file-upload";
export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const PACKAGE_PROFILE = "rheinagent-file-upload@1";
export const AUDIT_PROFILE = "rheinagent-file-upload@1";
export const HEALTH_PROFILE = "rheinagent-file-upload-v1";

/**
 * Canonical workflow crib sheet — the single source of truth for both the
 * server's initialize-time `instructions` (server.ts, seen once per session
 * without an extra tool call) and `rheinagent_file_capabilities_get`'s
 * `usage` field (seen whenever a client explicitly calls it, which many
 * agent frameworks do early by convention — a fallback for clients that
 * don't surface `instructions` to the model). Edit here only; both call
 * sites read this array so the two can't drift apart.
 */
export const USAGE_STEPS: readonly string[] = [
  "All ids (file_id, job_id, upload_id, delete_token, download_token) are opaque strings returned by this server — never construct or guess one.",
  "Discover: call rheinagent_file_capabilities_get once for limits and valid processor_id values; call rheinagent_file_health_get before heavy work if a previous call failed unexpectedly.",
  "Upload: rheinagent_file_upload_prepare -> PUT the raw bytes to the returned upload_url (not through MCP JSON) -> rheinagent_file_upload_finalize.",
  "Inspect: rheinagent_file_list (filterable by mime_category and/or filename_contains) / rheinagent_file_get. Small text files come back inline from rheinagent_file_get; anything else needs rheinagent_file_download_prepare -> GET the returned download_url. rheinagent_file_rename changes only the display filename, never mime_category or bytes. rheinagent_file_verify re-checks a file's SHA-256 against what was recorded at upload time (matches: false means the bytes on disk changed since acceptance). rheinagent_file_duplicate_check finds every other accepted file with identical content by SHA-256 (pass file_id, or sha256 directly to check before even uploading).",
  "Process: rheinagent_file_process_prepare (pick a processor_id from capabilities.processors whose supported_mime_categories includes the file's mime_category) -> rheinagent_file_process_apply -> rheinagent_file_job_get / rheinagent_file_result_get. Use rheinagent_file_job_list to find jobs again if a job_id was lost.",
  "Delete: rheinagent_file_delete_prepare -> rheinagent_file_delete_apply. The apply step asks for an explicit confirmation round-trip (elicitation) before it actually deletes anything.",
  "Rate limits apply per tool (see capabilities.limits.rate_limit_window_ms / rate_limits_per_window) — an isError result mentioning 'rate limit exceeded' means back off and retry after the window, not a permanent failure.",
];

export function getCapabilities() {
  const audit = loadAuditConfig();
  return {
    product_slug: PRODUCT_SLUG,
    mcp_protocol_version: MCP_PROTOCOL_VERSION,
    package_profile: PACKAGE_PROFILE,
    audit_profile: AUDIT_PROFILE,
    health_profile: HEALTH_PROFILE,
    audit_mode: audit.mode,
    limits: {
      max_upload_bytes: MAX_UPLOAD_BYTES,
      allowed_mime_categories: ["text", "pdf", "image", "office"],
      rate_limit_window_ms: WINDOW_MS,
      rate_limits_per_window: { ...LIMITS },
    },
    processors: listProcessorsWithCategories(),
    usage: [...USAGE_STEPS],
  };
}
