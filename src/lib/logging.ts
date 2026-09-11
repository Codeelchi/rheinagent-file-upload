/**
 * Structured logging for the control/data plane.
 *
 * IMPORTANT: the MCP `notifications/message` logging utility is deprecated
 * as of protocol 2026-07-28 (SEP-2577). The spec explicitly says new
 * implementations SHOULD NOT adopt it and SHOULD instead log to stderr (for
 * stdio transports) or use OpenTelemetry for structured observability. This
 * module therefore treats stderr/stdout structured logging as the primary,
 * recommended path (`log()` below) and only exposes the MCP notification
 * shape as a secondary, explicitly-deprecated export
 * (`buildLogNotification`) for callers that still need wire compatibility
 * with older clients that set `io.modelcontextprotocol/logLevel`. Do not
 * wire `buildLogNotification` in as if it were the forward-looking choice —
 * it isn't, per spec.
 *
 * Per this product's audit contract (see docs/AUDIT.md
 * "Audit-Privacy-Allowlist"), logs must never carry file content, filenames,
 * paths, hashes, or other content-bearing fields — the same spirit as
 * `audit.ts`'s `sanitizeMetadata`. `data` here only ever accepts a flat
 * allowlisted object, never an arbitrary payload.
 */

/** Syslog severity levels (RFC 5424), exactly as named by the MCP spec. */
export type LogLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "critical"
  | "alert"
  | "emergency";

// Ascending severity order — index is the ordinal used for comparisons.
const LEVEL_ORDER: readonly LogLevel[] = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
];

function levelIndex(level: LogLevel): number {
  const idx = LEVEL_ORDER.indexOf(level);
  if (idx === -1) throw new Error(`invalid log level: ${level}`);
  return idx;
}

/** True if `candidate` is at or above the severity of `configured`. */
export function shouldLog(configured: LogLevel, candidate: LogLevel): boolean {
  return levelIndex(candidate) >= levelIndex(configured);
}

// Defense in depth, mirroring audit.ts's SENSITIVE_KEY_PATTERNS: never let a
// log call accidentally carry something content-bearing even if a caller
// forgets to scrub it themselves.
const FORBIDDEN_DATA_KEY_PATTERNS = [
  "password", "passwd", "secret", "token", "authorization", "auth_header",
  "cookie", "session_key", "api_key", "apikey", "credential", "private_key",
  "body", "content", "prompt", "completion", "filename", "path", "filecontent",
  "hash", "sha256",
];

function isForbiddenDataKey(key: string): boolean {
  const lower = key.toLowerCase();
  return FORBIDDEN_DATA_KEY_PATTERNS.some((p) => lower.includes(p));
}

export type LogData = Record<string, string | number | boolean | null>;

function sanitizeData(data?: LogData): LogData | undefined {
  if (!data) return undefined;
  const out: LogData = {};
  for (const [key, value] of Object.entries(data)) {
    if (isForbiddenDataKey(key)) continue;
    out[key] = value;
  }
  return out;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  logger: string;
  message: string;
  data?: LogData;
}

/**
 * Recommended logging path: a structured JSON line on stderr. Safe to call
 * unconditionally — this has no MCP protocol dependency and works the same
 * whether or not any client ever sets a log level.
 */
export function log(level: LogLevel, logger: string, message: string, data?: LogData): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    logger,
    message,
    data: sanitizeData(data),
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

/** Convenience factory bound to a fixed logger name, so call sites don't
 * have to repeat it. */
export function createLogger(loggerName: string) {
  return {
    debug: (message: string, data?: LogData) => log("debug", loggerName, message, data),
    info: (message: string, data?: LogData) => log("info", loggerName, message, data),
    notice: (message: string, data?: LogData) => log("notice", loggerName, message, data),
    warning: (message: string, data?: LogData) => log("warning", loggerName, message, data),
    error: (message: string, data?: LogData) => log("error", loggerName, message, data),
    critical: (message: string, data?: LogData) => log("critical", loggerName, message, data),
    alert: (message: string, data?: LogData) => log("alert", loggerName, message, data),
    emergency: (message: string, data?: LogData) => log("emergency", loggerName, message, data),
  };
}

/**
 * @deprecated per MCP spec 2026-07-28 (SEP-2577) — the `notifications/message`
 * logging utility itself is deprecated platform-wide, not just this helper.
 * Kept only for callers that must stay wire-compatible with older clients
 * that still set `io.modelcontextprotocol/logLevel`. Builds the notification
 * payload; sending it is the caller's responsibility (this module has no
 * transport/server dependency).
 */
export function buildLogNotification(level: LogLevel, logger: string, data?: LogData) {
  return {
    method: "notifications/message" as const,
    params: {
      level,
      logger,
      data: sanitizeData(data),
    },
  };
}
