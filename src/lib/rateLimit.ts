/**
 * Rate limiting for MCP tool invocations (MCP spec 2026-07-28, server/tools
 * "Security Considerations": servers MUST rate limit tool invocations).
 *
 * MCP 2026-07-28 is a stateless protocol: there is no session or connection
 * identity a tool handler can reliably key on beyond what's in the current
 * request's `_meta` (see basic/index#meta), and this server does not require
 * client-supplied identity on every call. Limiting per-client would require
 * an identity we don't have and shouldn't invent. We therefore limit
 * per-tool-name, globally across all callers of this server process — a
 * coarser but honest granularity for a single-operator on-prem deployment
 * (see docs/SECURITY.md "known limitations": no multi-tenant separation in
 * this version). Per-client limiting can be layered on top later if/when
 * this server gains real caller identity.
 *
 * Weight classes give critical/destructive tools (upload_finalize,
 * process_apply, delete_apply) a stricter default budget than read tools
 * (list, get, job_get, result_get, capabilities_get) without requiring every
 * call site to pick its own number.
 */

export type WeightClass = "read" | "write" | "critical";

export class RateLimitExceededError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly weightClass: WeightClass,
    public readonly limit: number,
    public readonly windowMs: number,
  ) {
    super(
      `rate limit exceeded for "${toolName}" (${weightClass}): max ${limit} calls per ${windowMs}ms`,
    );
    this.name = "RateLimitExceededError";
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Defaults: read tools get the most headroom, write tools less, critical
// (destructive/irreversible-after-apply) tools the least. All configurable
// via env so an operator can tune without a code change.
// Exported (not just used internally below) so rheinagent_file_capabilities_get
// can tell a calling LLM client the actual pacing budget up front, instead
// of it learning the numbers only by tripping RateLimitExceededError.
export const WINDOW_MS = envInt("RHEINAGENT_FILE_UPLOAD_RATE_LIMIT_WINDOW_MS", 60_000);
export const LIMITS: Record<WeightClass, number> = {
  read: envInt("RHEINAGENT_FILE_UPLOAD_RATE_LIMIT_READ_PER_WINDOW", 120),
  write: envInt("RHEINAGENT_FILE_UPLOAD_RATE_LIMIT_WRITE_PER_WINDOW", 30),
  critical: envInt("RHEINAGENT_FILE_UPLOAD_RATE_LIMIT_CRITICAL_PER_WINDOW", 15),
};

interface Bucket {
  windowStart: number;
  count: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Options are for tests only (inject a short window instead of sleeping a
 * full minute); production call sites should omit `options` and rely on the
 * env-configured defaults above.
 */
export interface RateLimitOptions {
  windowMs?: number;
  limits?: Partial<Record<WeightClass, number>>;
  now?: () => number;
}

/**
 * Throws RateLimitExceededError if `toolName` has exceeded its weight
 * class's budget for the current window; otherwise records the call and
 * returns. Callers should catch RateLimitExceededError and turn it into an
 * MCP tool execution error (`isError: true`) rather than letting it crash
 * the process — a rate limit is a normal, model-recoverable-by-waiting
 * condition (see server/tools "Error Handling": Tool Execution Errors vs
 * Protocol Errors).
 */
export function checkRateLimit(
  toolName: string,
  weightClass: WeightClass,
  options?: RateLimitOptions,
): void {
  const windowMs = options?.windowMs ?? WINDOW_MS;
  const limit = options?.limits?.[weightClass] ?? LIMITS[weightClass];
  const now = (options?.now ?? Date.now)();

  const bucket = buckets.get(toolName);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    buckets.set(toolName, { windowStart: now, count: 1 });
    return;
  }

  if (bucket.count >= limit) {
    throw new RateLimitExceededError(toolName, weightClass, limit, windowMs);
  }

  bucket.count += 1;
}

/** Test/operator utility: drop all recorded buckets. */
export function resetRateLimits(): void {
  buckets.clear();
}
