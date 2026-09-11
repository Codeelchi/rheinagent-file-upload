import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkRateLimit,
  resetRateLimits,
  RateLimitExceededError,
} from "../src/lib/rateLimit.js";

test("requests under the limit succeed", () => {
  resetRateLimits();
  for (let i = 0; i < 5; i++) {
    assert.doesNotThrow(() =>
      checkRateLimit("rheinagent_file_list", "read", { windowMs: 1000, limits: { read: 5 } }),
    );
  }
});

test("requests over the limit throw RateLimitExceededError", () => {
  resetRateLimits();
  const opts = { windowMs: 1000, limits: { write: 3 } as const };
  for (let i = 0; i < 3; i++) {
    checkRateLimit("rheinagent_file_upload_finalize", "write", opts);
  }
  assert.throws(
    () => checkRateLimit("rheinagent_file_upload_finalize", "write", opts),
    RateLimitExceededError,
  );
});

test("thrown error carries the tool name, weight class, limit and window", () => {
  resetRateLimits();
  const opts = { windowMs: 1000, limits: { critical: 1 } as const };
  checkRateLimit("rheinagent_file_delete_apply", "critical", opts);
  try {
    checkRateLimit("rheinagent_file_delete_apply", "critical", opts);
    assert.fail("expected RateLimitExceededError");
  } catch (err) {
    assert.ok(err instanceof RateLimitExceededError);
    assert.equal(err.toolName, "rheinagent_file_delete_apply");
    assert.equal(err.weightClass, "critical");
    assert.equal(err.limit, 1);
    assert.equal(err.windowMs, 1000);
  }
});

test("different tool names have independent buckets", () => {
  resetRateLimits();
  const opts = { windowMs: 1000, limits: { critical: 1 } as const };
  checkRateLimit("rheinagent_file_delete_apply", "critical", opts);
  assert.doesNotThrow(() => checkRateLimit("rheinagent_file_process_apply", "critical", opts));
});

test("the window resets after the configured period", () => {
  resetRateLimits();
  let now = 1_000_000;
  const opts = { windowMs: 500, limits: { read: 1 } as const, now: () => now };
  checkRateLimit("rheinagent_file_get", "read", opts);
  assert.throws(() => checkRateLimit("rheinagent_file_get", "read", opts), RateLimitExceededError);

  now += 501; // past the window
  assert.doesNotThrow(() => checkRateLimit("rheinagent_file_get", "read", opts));
});
