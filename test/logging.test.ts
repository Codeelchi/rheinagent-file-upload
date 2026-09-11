import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldLog, buildLogNotification, type LogLevel } from "../src/lib/logging.js";

const LEVELS_ASCENDING: LogLevel[] = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
];

// --- severity ordering ---

test("shouldLog: every level logs itself", () => {
  for (const level of LEVELS_ASCENDING) {
    assert.equal(shouldLog(level, level), true);
  }
});

test("shouldLog: higher-severity candidate passes a lower-severity configured minimum", () => {
  for (let i = 0; i < LEVELS_ASCENDING.length; i++) {
    for (let j = i; j < LEVELS_ASCENDING.length; j++) {
      assert.equal(
        shouldLog(LEVELS_ASCENDING[i], LEVELS_ASCENDING[j]),
        true,
        `${LEVELS_ASCENDING[j]} should pass configured minimum ${LEVELS_ASCENDING[i]}`,
      );
    }
  }
});

test("shouldLog: lower-severity candidate is suppressed below a higher configured minimum", () => {
  for (let i = 1; i < LEVELS_ASCENDING.length; i++) {
    for (let j = 0; j < i; j++) {
      assert.equal(
        shouldLog(LEVELS_ASCENDING[i], LEVELS_ASCENDING[j]),
        false,
        `${LEVELS_ASCENDING[j]} should be suppressed below configured minimum ${LEVELS_ASCENDING[i]}`,
      );
    }
  }
});

test("shouldLog: full known ordering sanity spot-checks", () => {
  assert.equal(shouldLog("warning", "debug"), false);
  assert.equal(shouldLog("warning", "error"), true);
  assert.equal(shouldLog("emergency", "alert"), false);
  assert.equal(shouldLog("debug", "emergency"), true);
});

test("shouldLog throws on an invalid level", () => {
  // @ts-expect-error deliberately invalid input
  assert.throws(() => shouldLog("warning", "not-a-level"));
});

// --- notification payload shape (spec: method notifications/message, params {level, logger, data}) ---

test("buildLogNotification produces the exact spec shape", () => {
  const n = buildLogNotification("error", "database", { status_code: 500 });
  assert.equal(n.method, "notifications/message");
  assert.equal(n.params.level, "error");
  assert.equal(n.params.logger, "database");
  assert.deepEqual(n.params.data, { status_code: 500 });
});

test("buildLogNotification omits data when not provided", () => {
  const n = buildLogNotification("info", "control-plane");
  assert.equal(n.params.data, undefined);
});

test("buildLogNotification strips forbidden-looking data keys (defense in depth)", () => {
  const n = buildLogNotification("info", "upload", {
    filename: "should-be-stripped.txt",
    mime_category: "text",
  } as unknown as Record<string, string>);
  assert.deepEqual(n.params.data, { mime_category: "text" });
});
