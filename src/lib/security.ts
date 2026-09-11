import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Validation and filesystem-safety primitives for the upload data plane.
 * Nothing here ever trusts a client-supplied path segment — every on-disk
 * path is built exclusively from our own opaque ids (see ids.ts) plus a
 * fixed base directory, and every resolved path is re-checked to still be
 * inside that base directory before any read/write/rename/unlink.
 */

export const MAX_UPLOAD_BYTES = Number(
  process.env.RHEINAGENT_FILE_UPLOAD_MAX_BYTES ?? 25 * 1024 * 1024,
);

export type MimeCategory = "text" | "pdf" | "image" | "archive" | "unknown";

const EXTENSION_ALLOWLIST: Record<string, MimeCategory> = {
  ".txt": "text",
  ".md": "text",
  ".csv": "text",
  ".json": "text",
  ".pdf": "pdf",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
};

// Archive formats are recognized (for honest categorization) but never
// accepted for upload in this version: we do not implement any decompression
// processor, so archive-bomb risk is structurally excluded by never
// unpacking anything server-side, rather than by size-ratio heuristics.
const BLOCKED_EXTENSIONS = new Set([".zip", ".tar", ".gz", ".7z", ".rar"]);

export function extensionOf(filename: string): string {
  return path.extname(filename).toLowerCase();
}

export function classifyExtension(filename: string): MimeCategory | null {
  const ext = extensionOf(filename);
  if (BLOCKED_EXTENSIONS.has(ext)) return null;
  return EXTENSION_ALLOWLIST[ext] ?? null;
}

/** Magic-byte sniffing, independent of the claimed extension. A mismatch
 * between extension-derived category and sniffed category is rejected by
 * the caller — this stops an executable or archive being smuggled in under
 * a ".txt" extension. */
export function sniffMimeCategory(buf: Buffer): MimeCategory {
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return "pdf"; // %PDF
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return "image"; // \x89PNG
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image"; // JPEG SOI
  }
  if (
    buf.length >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)
  ) {
    return "archive"; // PK\x03\x04 and friends (also covers docx/xlsx/jar)
  }
  // Heuristic text check: no NUL bytes and mostly printable in the sampled
  // prefix. Anything else is "unknown" and rejected.
  const sample = buf.subarray(0, Math.min(buf.length, 512));
  let controlBytes = 0;
  for (const byte of sample) {
    if (byte === 0) return "unknown";
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) controlBytes++;
  }
  if (controlBytes / Math.max(sample.length, 1) < 0.05) return "text";
  return "unknown";
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Resolve `segment` under `baseDir` and verify the result did not escape
 * `baseDir` (defense in depth on top of ids.ts only ever producing our own
 * opaque segments — this still catches a future regression). */
export async function safeJoin(baseDir: string, segment: string): Promise<string> {
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, segment);
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
    throw new Error("path escapes base directory");
  }
  return resolved;
}

/** Refuse to operate through a symlink anywhere a path is about to be
 * created or replaced. Our own ids never collide with existing files, so
 * finding a symlink at a path we are about to write to is always suspicious. */
export async function assertNotSymlink(targetPath: string): Promise<void> {
  try {
    const st = await fs.lstat(targetPath);
    if (st.isSymbolicLink()) {
      throw new Error("refusing to operate through a symlink");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
