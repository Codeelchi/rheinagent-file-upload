import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { AUDIT_ACTIONS, AUDIT_PROFILE_ID } from "../src/lib/audit.js";

type ManifestAction = {
  tool: string;
  action: string;
  classification: string;
  risk: string;
  sensitive?: boolean;
  write_ahead: boolean;
  target_type: string;
  allowed_metadata: string[];
};

test("portable Audit Hub profile exactly matches the TypeScript runtime mapping", async () => {
  const raw = JSON.parse(await fs.readFile("audit/rheinagent-file-upload-v1.json", "utf-8")) as {
    schema: string;
    profile_id: string;
    product: string;
    component: string;
    actions: ManifestAction[];
  };

  assert.equal(raw.schema, "rheinagent-audit-profile/v1");
  assert.equal(raw.profile_id, AUDIT_PROFILE_ID);
  assert.equal(raw.product, "rheinagent-file-upload");
  assert.equal(raw.component, "file-upload-mcp");
  assert.equal(raw.actions.length, 18);

  const manifestByTool = new Map(raw.actions.map((action) => [action.tool, action]));
  assert.equal(manifestByTool.size, raw.actions.length, "duplicate tool in audit manifest");
  assert.deepEqual([...manifestByTool.keys()].sort(), Object.keys(AUDIT_ACTIONS).sort());

  for (const [tool, runtime] of Object.entries(AUDIT_ACTIONS)) {
    const manifest = manifestByTool.get(tool);
    assert.ok(manifest, "missing manifest action for " + tool);
    assert.equal(manifest.action, runtime.action, tool + " action drift");
    assert.equal(manifest.classification, runtime.classification, tool + " classification drift");
    assert.equal(manifest.risk, runtime.risk, tool + " risk drift");
    assert.equal(manifest.write_ahead, runtime.writeAhead, tool + " write-ahead drift");
    assert.equal(manifest.target_type, runtime.targetType, tool + " target type drift");
    assert.equal(Boolean(manifest.sensitive), Boolean("sensitive" in runtime && runtime.sensitive), tool + " sensitive drift");
    assert.deepEqual(manifest.allowed_metadata, [...runtime.allowedMetadataKeys], tool + " metadata allowlist drift");
  }
});

test("Audit profile covers exactly the 18 MCP tools registered by server.ts", async () => {
  const serverSource = await fs.readFile("server.ts", "utf-8");
  const registered = [...serverSource.matchAll(/server\.registerTool\(\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.equal(registered.length, 18);
  assert.equal(new Set(registered).size, 18, "server.ts registers a duplicate tool name");
  assert.deepEqual(registered.sort(), Object.keys(AUDIT_ACTIONS).sort());
});

test("every critical Audit classification is write-ahead", () => {
  const critical = new Set(["WRITE", "DELETE", "SECURITY", "CONFIG", "UPDATE"]);
  for (const [tool, spec] of Object.entries(AUDIT_ACTIONS)) {
    if (critical.has(spec.classification)) {
      assert.equal(spec.writeAhead, true, tool + " must be write-ahead");
    }
  }
});
