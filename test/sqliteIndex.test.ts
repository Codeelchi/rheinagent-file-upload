import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SqliteIndex, migrateJsonFileIfPresent } from "../src/lib/sqliteIndex.js";

// The persistence layer every store.ts table sits on top of, replacing the
// old whole-file JsonIndex (see docs/STATE-MIGRATION.md). Same behavioral
// contract (get/values/set/delete) is exercised here, plus SQLite-specific
// concerns (table auto-create, cross-instance visibility via WAL, legacy
// JSON migration).

interface Widget {
  name: string;
  count: number;
}

async function withTempDbFile(fn: (filePath: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raf-sqliteindex-test-"));
  const filePath = path.join(dir, "nested", "state.sqlite"); // nested: also exercises mkdir(recursive)
  try {
    await fn(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("get() on a never-written table returns undefined without throwing", async () => {
  await withTempDbFile(async (filePath) => {
    const index = new SqliteIndex<Widget>(filePath, "widgets");
    assert.equal(await index.get("missing"), undefined);
    assert.deepEqual(await index.values(), []);
  });
});

test("set()/get() round-trip and values() lists everything", async () => {
  await withTempDbFile(async (filePath) => {
    const index = new SqliteIndex<Widget>(filePath, "widgets");
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
  await withTempDbFile(async (filePath) => {
    await assert.rejects(() => fs.access(path.dirname(filePath)));
    const index = new SqliteIndex<Widget>(filePath, "widgets");
    await index.set("a", { name: "alpha", count: 1 });
    await assert.doesNotReject(() => fs.access(path.dirname(filePath)));
  });
});

test("set() overwrites an existing id in place, leaving other entries untouched", async () => {
  await withTempDbFile(async (filePath) => {
    const index = new SqliteIndex<Widget>(filePath, "widgets");
    await index.set("a", { name: "alpha", count: 1 });
    await index.set("b", { name: "beta", count: 2 });
    await index.set("a", { name: "alpha-v2", count: 99 });

    assert.deepEqual(await index.get("a"), { name: "alpha-v2", count: 99 });
    assert.deepEqual(await index.get("b"), { name: "beta", count: 2 });
    assert.equal((await index.values()).length, 2);
  });
});

test("delete() removes an id and returns true; returns false for an id that never existed", async () => {
  await withTempDbFile(async (filePath) => {
    const index = new SqliteIndex<Widget>(filePath, "widgets");
    await index.set("a", { name: "alpha", count: 1 });

    assert.equal(await index.delete("a"), true);
    assert.equal(await index.get("a"), undefined);

    assert.equal(await index.delete("never-existed"), false);
  });
});

test("two SqliteIndex instances on the same file+table see each other's writes (WAL, no in-process cache)", async () => {
  // Mirrors the real cross-process situation (control plane vs data plane)
  // using two independent instances instead of two OS processes.
  await withTempDbFile(async (filePath) => {
    const writer = new SqliteIndex<Widget>(filePath, "widgets");
    const reader = new SqliteIndex<Widget>(filePath, "widgets");
    await writer.set("a", { name: "alpha", count: 1 });
    assert.deepEqual(await reader.get("a"), { name: "alpha", count: 1 });

    await writer.set("a", { name: "alpha-v2", count: 2 });
    assert.deepEqual(await reader.get("a"), { name: "alpha-v2", count: 2 }, "reader must see the writer's update, not a stale cached copy");
  });
});

test("distinct table names on the same db file are independent", async () => {
  await withTempDbFile(async (filePath) => {
    const widgets = new SqliteIndex<Widget>(filePath, "widgets");
    const gadgets = new SqliteIndex<Widget>(filePath, "gadgets");
    await widgets.set("a", { name: "widget-a", count: 1 });
    await gadgets.set("a", { name: "gadget-a", count: 2 });

    assert.deepEqual(await widgets.get("a"), { name: "widget-a", count: 1 });
    assert.deepEqual(await gadgets.get("a"), { name: "gadget-a", count: 2 });
    assert.equal((await widgets.values()).length, 1);
  });
});

test("migrateJsonFileIfPresent imports legacy JsonIndex-format data and renames the source file", async () => {
  await withTempDbFile(async (filePath) => {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const jsonFilePath = path.join(dir, "widgets.json");
    const legacyEntries: [string, Widget][] = [
      ["a", { name: "alpha", count: 1 }],
      ["b", { name: "beta", count: 2 }],
    ];
    await fs.writeFile(jsonFilePath, JSON.stringify(legacyEntries, null, 2), "utf-8");

    const index = new SqliteIndex<Widget>(filePath, "widgets");
    const result = await migrateJsonFileIfPresent(jsonFilePath, index);
    assert.equal(result.migrated, 2);

    assert.deepEqual(await index.get("a"), { name: "alpha", count: 1 });
    assert.deepEqual(await index.get("b"), { name: "beta", count: 2 });

    await assert.rejects(() => fs.access(jsonFilePath), "legacy file must be renamed away, not left in place");
    await assert.doesNotReject(() => fs.access(`${jsonFilePath}.migrated`));
  });
});

test("migrateJsonFileIfPresent is a no-op when no legacy file exists", async () => {
  await withTempDbFile(async (filePath) => {
    const index = new SqliteIndex<Widget>(filePath, "widgets");
    const result = await migrateJsonFileIfPresent(path.join(path.dirname(filePath), "nope.json"), index);
    assert.equal(result.migrated, 0);
  });
});

test("migrateJsonFileIfPresent does not overwrite a table that already has data", async () => {
  await withTempDbFile(async (filePath) => {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const jsonFilePath = path.join(dir, "widgets.json");
    await fs.writeFile(jsonFilePath, JSON.stringify([["a", { name: "from-json", count: 1 }]]), "utf-8");

    const index = new SqliteIndex<Widget>(filePath, "widgets");
    await index.set("a", { name: "already-here", count: 99 }); // table already has data

    const result = await migrateJsonFileIfPresent(jsonFilePath, index);
    assert.equal(result.migrated, 0, "must not import over existing rows");
    assert.deepEqual(await index.get("a"), { name: "already-here", count: 99 });
    // legacy file is left untouched (not renamed) since nothing was imported
    await assert.doesNotReject(() => fs.access(jsonFilePath));
  });
});
