import { randomUUID } from "node:crypto";

/**
 * Opaque identifiers. Never derived from user-supplied filenames or paths —
 * MCP tools and on-disk storage paths must only ever see these, never the
 * original filename as a path segment (path traversal prevention by
 * construction, not by sanitization).
 */

const ID_PATTERN = /^[a-z]+_[0-9a-f-]{36}$/;

function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function newUploadId(): string {
  return newId("upl");
}

export function newFileId(): string {
  return newId("file");
}

export function newJobId(): string {
  return newId("job");
}

export function newDeleteToken(): string {
  return newId("del");
}

export function newDownloadToken(): string {
  return newId("dl");
}

/** Reject anything that isn't one of our own generated opaque ids before it
 * ever touches a filesystem path. */
export function assertOpaqueId(id: string): void {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new Error("invalid opaque id");
  }
}
