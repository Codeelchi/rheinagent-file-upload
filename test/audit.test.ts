import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAuditConfig, checkHubEndpointReachable } from "../src/lib/audit.js";

// loadAuditConfig() and checkHubEndpointReachable() are the parts of the
// audit client this repo can actually verify without a live Hub instance
// (see docs/HANDOFF.md — the write-ahead contract itself stays
// implemented-but-unverified). These back the health tool's audit block.

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("loadAuditConfig defaults to off with no env set", () => {
  withEnv({ RA_AUDIT_MODE: undefined }, () => {
    assert.equal(loadAuditConfig().mode, "off");
  });
});

test("loadAuditConfig rejects an invalid RA_AUDIT_MODE", () => {
  withEnv({ RA_AUDIT_MODE: "bogus" }, () => {
    assert.throws(() => loadAuditConfig(), /invalid RA_AUDIT_MODE/);
  });
});

test("checkHubEndpointReachable is a no-op (undefined) in off mode", async () => {
  const cfg = { mode: "off" as const, protocolVersion: "rheinagent-audit/1" };
  assert.equal(await checkHubEndpointReachable(cfg), undefined);
});

test("checkHubEndpointReachable is undefined in hub mode with no endpoint configured", async () => {
  const cfg = { mode: "hub" as const, protocolVersion: "rheinagent-audit/1" };
  assert.equal(await checkHubEndpointReachable(cfg), undefined);
});

test("checkHubEndpointReachable returns false for an unreachable endpoint", async () => {
  const cfg = {
    mode: "hub" as const,
    endpoint: "http://127.0.0.1:1", // port 1 is never listening
    protocolVersion: "rheinagent-audit/1",
  };
  assert.equal(await checkHubEndpointReachable(cfg), false);
});
