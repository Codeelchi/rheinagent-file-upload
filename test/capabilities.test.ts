import { test } from "node:test";
import assert from "node:assert/strict";
import { getCapabilities, USAGE_STEPS } from "../src/lib/capabilities.js";
import { CapabilitiesSchema } from "../src/lib/schemas.js";

// getCapabilities() had no dedicated coverage before — everything else
// only exercised it indirectly through the (untested-at-unit-level)
// rheinagent_file_capabilities_get tool handler in server.ts.

test("getCapabilities() output matches CapabilitiesSchema", () => {
  const parsed = CapabilitiesSchema.safeParse(getCapabilities());
  assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues));
});

test("getCapabilities().usage is exactly USAGE_STEPS (single source of truth)", () => {
  assert.deepEqual(getCapabilities().usage, [...USAGE_STEPS]);
});

test("getCapabilities().limits carries the rate-limit budget an LLM client needs to pace itself", () => {
  const caps = getCapabilities();
  assert.ok(caps.limits.rate_limit_window_ms > 0);
  assert.ok(caps.limits.rate_limits_per_window.read > 0);
  assert.ok(caps.limits.rate_limits_per_window.write > 0);
  assert.ok(caps.limits.rate_limits_per_window.critical > 0);
});
