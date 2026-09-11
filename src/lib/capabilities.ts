import { MAX_UPLOAD_BYTES } from "./security.js";
import { listProcessorIds } from "./processors.js";
import { loadAuditConfig } from "./audit.js";

export const PRODUCT_SLUG = "rheinagent-file-upload";
export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const PACKAGE_PROFILE = "rheinagent-file-upload@1";
export const AUDIT_PROFILE = "rheinagent-file-upload@1";
export const HEALTH_PROFILE = "rheinagent-file-upload-v1";

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
      allowed_mime_categories: ["text", "pdf", "image"],
    },
    processors: listProcessorIds(),
  };
}
