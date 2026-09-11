import { randomUUID } from "node:crypto";

/**
 * Opaque identifiers. Never derived from user-supplied filenames or paths —
 * MCP tools and on-disk storage paths must only ever see these, never the
 * original filename as a path segment (path traversal prevention by
 * construction, not by sanitization).
 */

// Exported (not just used internally by assertOpaqueId) so tool input
// schemas in server.ts can validate id-shaped arguments at the MCP-protocol
// layer — a malformed id then surfaces as a standard schema-validation
// error instead of falling through to assertOpaqueId() deep inside a store
// call and being reported as a generic "internal error".
export const ID_PATTERN = /^[a-z]+_[0-9a-f-]{36}$/;

// Named prefixes, exported so zod input schemas can build a *per-kind*
// pattern (e.g. reject a job_id where a file_id is expected) instead of
// only the generic "is this shaped like any opaque id" check above.
export const ID_PREFIXES = {
  upload: "upl",
  file: "file",
  job: "job",
  delete: "del",
  download: "dl",
} as const;

function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function newUploadId(): string {
  return newId(ID_PREFIXES.upload);
}

export function newFileId(): string {
  return newId(ID_PREFIXES.file);
}

export function newJobId(): string {
  return newId(ID_PREFIXES.job);
}

export function newDeleteToken(): string {
  return newId(ID_PREFIXES.delete);
}

export function newDownloadToken(): string {
  return newId(ID_PREFIXES.download);
}

/** Regex for one specific id kind, e.g. `idPattern(ID_PREFIXES.file)` only
 * matches `file_<uuid>`, not `job_<uuid>`. */
export function idPattern(prefix: string): RegExp {
  return new RegExp(`^${prefix}_[0-9a-f-]{36}$`);
}

/** Reject anything that isn't one of our own generated opaque ids before it
 * ever touches a filesystem path. */
export function assertOpaqueId(id: string): void {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new Error("invalid opaque id");
  }
}
