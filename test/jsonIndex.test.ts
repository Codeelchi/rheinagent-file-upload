import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonIndex } from "../src/lib/jsonIndex.js";

// The persistence layer every store.ts table sits on top of — previously
// the only src/lib module with zero dedicated test coverage, despite being
// where a bug would silently corrupt or lose data across the whole product.

interface Widget {
  name: string;
  count: number;
}

async function withTempIndexFile(fn: (filePath: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raf-jsonindex-test-"));
  const filePath = path.join(dir, "nested", "index.json"); // nested: also exercises mkdir(recursive)
  try {
    await fn(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("get() on a never-written index returns undefined without throwing (ENOENT handled)", async () => {
  await withTempIndexFile(async (filePath) => {
    const index = new JsonIndex<Widget>(filePath);
    assert.equal(await index.get("missing"), undefined);
    assert.deepEqual(await index.values(), []);
  });
});

test("set()/get() round-trip and values() lists everything", async () => {
  await withTempIndexFile(async (filePath) => {
    const index = new JsonIndex<Widget>(filePath);
    await index.set("a", { name: "alpha", count: 1 });
    await index.set("b", { name: "beta", count: 2 });

    assert.deepEqual(await index.get("a"), { name: "alpha", count: 1 });
    const all = await index.values();
    assert.equal(all.length, 2);
    assert.ok(all.some((w) => w.name === "alpha"));
    assert.ok(all.some((w) => w.name === "beta"));
  });
});

test("set() creates the parent directory if it doesn't exist yet", async () => {
  await withTempIndexFile(async (filePath) => {
    await assert.rejects(() => fs.access(path.dirname(filePath)));
    const index = new JsonIndex<Widget>(filePath);
    await index.set("a", { name: "alpha", count: 1 });
    await assert.doesNotReject(() => fs.access(path.dirname(filePath)));
  });
});

test("set() overwrites an existing id in place, leaving other entries untouched", async () => {
  await withTempIndexFile(async (filePath) => {
    const index = new JsonIndex<Widget>(filePath);
    await index.set("a", { name: "alpha", count: 1 });
    await index.set("b", { name: "beta", count: 2 });
    await index.set("a", { name: "alpha-v2", count: 99 });

    assert.deepEqual(await index.get("a"), { name: "alpha-v2", count: 99 });
    assert.deepEqual(await index.get("b"), { name: "beta", count: 2 });
    assert.equal((await index.values()).length, 2);
  });
});

test("delete() removes an id and returns true; returns false for an id that never existed", async () => {
  await withTempIndexFile(async (filePath) => {
    const index = new JsonIndex<Widget>(filePath);
    await index.set("a", { name: "alpha", count: 1 });

    assert.equal(await index.delete("a"), true);
    assert.equal(await index.get("a"), undefined);

    assert.equal(await index.delete("never-existed"), false);
  });
});

test("delete() of a nonexistent id does not create the index file (no unnecessary write)", async () => {
  await withTempIndexFile(async (filePath) => {
    const index = new JsonIndex<Widget>(filePath);
    await index.delete("never-existed");
    await assert.rejects(() => fs.access(filePath), "delete() with nothing to remove must not persist an empty file");
  });
});

test("a second JsonIndex instance pointed at the same file sees writes from the first (no in-process cache)", async () => {
  // Mirrors the real cross-process situation (control plane vs data plane,
  // see the class docstring) using two independent instances instead of
  // two OS processes.
  await withTempIndexFile(async (filePath) => {
    const writer = new JsonIndex<Widget>(filePath);
    const reader = new JsonIndex<Widget>(filePath);
    await writer.set("a", { name: "alpha", count: 1 });
    assert.deepEqual(await reader.get("a"), { name: "alpha", count: 1 });

    await writer.set("a", { name: "alpha-v2", count: 2 });
    assert.deepEqual(await reader.get("a"), { name: "alpha-v2", count: 2 }, "reader must see the writer's update, not a stale cached copy");
  });
});

test("persisted file is valid, re-loadable JSON after multiple writes (atomic rename leaves no partial file)", async () => {
  await withTempIndexFile(async (filePath) => {
    const index = new JsonIndex<Widget>(filePath);
    for (let i = 0; i < 5; i++) await index.set(`id-${i}`, { name: `item-${i}`, count: i });

    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw); // must not throw — no leftover .tmp-* content or partial write
    assert.equal(parsed.length, 5);

    // no stray .tmp-* files left behind in the directory
    const siblingFiles = await fs.readdir(path.dirname(filePath));
    assert.deepEqual(siblingFiles, [path.basename(filePath)]);
  });
});

test("malformed JSON on disk throws instead of being silently treated as an empty index", async () => {
  await withTempIndexFile(async (filePath) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{ this is not valid JSON", "utf-8");
    const index = new JsonIndex<Widget>(filePath);
    // Only ENOENT is treated as "empty index" — real corruption must
    // surface as an error, not silently discard whatever was on disk.
    await assert.rejects(() => index.get("a"));
  });
});
