import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DATA_DIR,
  PRODUCT_ROOT,
  findProductRoot,
  readProductVersion,
  resolveDataDir,
} from "../src/lib/runtimePaths.js";

test("findProductRoot resolves the current source-tree package root", () => {
  assert.equal(findProductRoot(import.meta.dirname), PRODUCT_ROOT);
  assert.equal(readProductVersion(PRODUCT_ROOT), "0.3.0");
});

test("findProductRoot also resolves from the compiled dist/src/lib layout", () => {
  const simulatedCompiledModuleDir = path.join(PRODUCT_ROOT, "dist", "src", "lib");
  assert.equal(findProductRoot(simulatedCompiledModuleDir), PRODUCT_ROOT);
});

test("resolveDataDir defaults to <product-root>/data", () => {
  assert.equal(DATA_DIR, path.join(PRODUCT_ROOT, "data"));
  assert.equal(resolveDataDir(undefined, PRODUCT_ROOT), path.join(PRODUCT_ROOT, "data"));
});

test("resolveDataDir accepts absolute and product-root-relative overrides", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "raf-runtime-paths-"));
  try {
    const absolute = path.join(temp, "absolute-data");
    assert.equal(resolveDataDir(absolute, PRODUCT_ROOT), path.normalize(absolute));
    assert.equal(resolveDataDir("var/data", temp), path.join(temp, "var", "data"));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
