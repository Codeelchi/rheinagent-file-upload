import zlib from "node:zlib";

/**
 * Minimal, hand-rolled ZIP central-directory reader + bounded inflate, used
 * only to pull specific named XML parts out of a `.docx`/`.xlsx` file (both
 * are ZIP containers under the OOXML spec). Deliberately NOT a general
 * unzip utility: it never writes anything to disk, never resolves an entry
 * name as a filesystem path (so classic zip-slip/path-traversal via entry
 * names is structurally not applicable here — entry names are only ever
 * used as in-memory Map keys), and only inflates entries the caller
 * explicitly asks for by exact name. Every other entry in the archive is
 * skipped without ever being decompressed.
 *
 * Zip-bomb defense: `maxOutputLength` (Node's own zlib option) caps the
 * inflated size of each entry we do decompress and throws before it can
 * materialize an oversized buffer in memory; `MAX_ENTRIES` caps how many
 * central-directory records we're willing to scan at all, defending
 * against an entry-count bomb (an archive listing millions of tiny/empty
 * entries) independent of any single entry's size.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const MAX_ENTRIES = 5000;
const EOCD_SEARCH_WINDOW = 65557; // 22-byte EOCD + max 65535-byte comment

export interface UnzipOptions {
  /** Exact entry names to extract; every other entry is skipped without decompression. */
  wantedNames: Set<string>;
  /** Per-entry cap passed straight to zlib's own maxOutputLength guard. */
  maxEntryInflatedBytes: number;
  /** Cumulative cap across every entry actually inflated in this call. */
  maxTotalInflatedBytes: number;
}

function findEndOfCentralDirectory(buf: Buffer): number {
  const start = Math.max(0, buf.length - EOCD_SEARCH_WINDOW);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error("not a valid ZIP container (no end-of-central-directory record found)");
}

/**
 * Reads the requested entries from a ZIP buffer, returning their inflated
 * bytes keyed by entry name. Missing wanted entries are simply absent from
 * the result map (not an error — callers decide what a missing part means,
 * e.g. "this docx has no word/document.xml" is a content error, not a zip
 * error).
 */
export function readZipEntries(buf: Buffer, options: UnzipOptions): Map<string, Buffer> {
  const eocdOffset = findEndOfCentralDirectory(buf);
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);
  if (totalEntries > MAX_ENTRIES) {
    throw new Error(`ZIP container declares ${totalEntries} entries, exceeding the ${MAX_ENTRIES} limit`);
  }

  const result = new Map<string, Buffer>();
  let totalInflated = 0;
  let offset = centralDirOffset;
  let remainingWanted = new Set(options.wantedNames);

  for (let i = 0; i < totalEntries && remainingWanted.size > 0; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error("malformed ZIP central directory record");
    }
    const compressionMethod = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const filenameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const filename = buf.toString("utf-8", offset + 46, offset + 46 + filenameLength);
    offset += 46 + filenameLength + extraLength + commentLength;

    if (!remainingWanted.has(filename)) continue;
    remainingWanted.delete(filename);

    if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_SIGNATURE) {
      throw new Error(`malformed ZIP local file header for entry "${filename}"`);
    }
    const localFilenameLength = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localFilenameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) throw new Error(`ZIP entry "${filename}" data extends past end of archive`);
    const compressedData = buf.subarray(dataStart, dataEnd);

    const remainingBudget = options.maxTotalInflatedBytes - totalInflated;
    const entryCap = Math.min(options.maxEntryInflatedBytes, Math.max(remainingBudget, 0));
    let inflated: Buffer;
    if (compressionMethod === 0) {
      // stored (no compression) — still subject to the same cap
      if (compressedData.length > entryCap) {
        throw new Error(`ZIP entry "${filename}" exceeds the ${entryCap}-byte inflation budget`);
      }
      inflated = Buffer.from(compressedData);
    } else if (compressionMethod === 8) {
      try {
        inflated = zlib.inflateRawSync(compressedData, { maxOutputLength: entryCap });
      } catch (err) {
        throw new Error(`ZIP entry "${filename}" exceeds the inflation budget or is corrupt: ${(err as Error).message}`);
      }
    } else {
      throw new Error(`ZIP entry "${filename}" uses unsupported compression method ${compressionMethod}`);
    }
    totalInflated += inflated.length;
    result.set(filename, inflated);
  }

  return result;
}
