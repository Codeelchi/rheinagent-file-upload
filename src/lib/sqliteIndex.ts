import fs from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * SQLite-backed index with the exact same public shape as the legacy
 * `JsonIndex<T>` (get/values/set/delete) — every `store.ts` table only ever
 * calls those four methods, so this is a drop-in replacement, not a
 * rewrite of the callers. Uses Node's built-in `node:sqlite` (stable since
 * Node 22, zero extra runtime dependency — same reasoning as the
 * `pdfjs-dist`-over-native-addon call in docs/SECURITY.md: no compiled
 * native binary on an arm64 on-prem box) instead of `better-sqlite3`.
 *
 * Replaces the previous whole-file-JSON-rewrite-per-write model (see
 * `jsonIndex.ts`, kept only for one-time migration of pre-existing dev
 * data) with real per-row transactions in WAL mode. That directly closes
 * the "last write wins" race documented in docs/SECURITY.md: the control
 * plane and data plane are separate OS processes that both read/write the
 * same `uploads` table, and two processes writing to the same JSON file at
 * once could silently clobber each other's write. WAL mode lets readers
 * proceed without blocking a writer and serializes concurrent writers
 * through SQLite's own locking instead of two `fs.rename()`s racing.
 *
 * One `.sqlite` file can hold many tables — every `store.ts` index passes
 * the same `data/state.sqlite` path with a distinct `tableName`, and
 * connections to the same file are cached/shared (`openDatabases`) so we
 * don't open five separate handles to the same file, re-run the WAL pragma
 * five times, or let one process's five tables fight each other over the
 * same file lock unnecessarily.
 */

const openDatabases = new Map<string, DatabaseSync>();

function openDatabase(filePath: string): DatabaseSync {
  const existing = openDatabases.get(filePath);
  if (existing) return existing;
  if (filePath !== ":memory:") mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  // WAL: readers don't block writers, and writers from a second OS process
  // (the other plane) serialize safely instead of corrupting the file.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  openDatabases.set(filePath, db);
  return db;
}

export class SqliteIndex<T> {
  private readonly db: DatabaseSync;
  private readonly table: string;

  constructor(
    private readonly filePath: string,
    tableName: string,
  ) {
    // Table names are hardcoded call sites (store.ts), never client input —
    // safe to interpolate directly, no SQL-injection surface.
    this.table = tableName;
    this.db = openDatabase(filePath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS "${this.table}" (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  }

  async get(id: string): Promise<T | undefined> {
    const row = this.db.prepare(`SELECT value FROM "${this.table}" WHERE id = ?`).get(id) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  async values(): Promise<T[]> {
    const rows = this.db.prepare(`SELECT value FROM "${this.table}"`).all() as { value: string }[];
    return rows.map((r) => JSON.parse(r.value) as T);
  }

  async set(id: string, value: T): Promise<void> {
    this.db
      .prepare(`INSERT INTO "${this.table}" (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value`)
      .run(id, JSON.stringify(value));
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.prepare(`DELETE FROM "${this.table}" WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /** Row count without deserializing every value — used by the one-time
   * migration to decide whether this table already has data (skip import)
   * or is still empty (safe to import from the legacy JSON file). */
  async count(): Promise<number> {
    const row = this.db.prepare(`SELECT COUNT(*) as n FROM "${this.table}"`).get() as { n: number };
    return row.n;
  }
}

/**
 * One-time migration of pre-existing `JsonIndex` data (whole-file JSON
 * under `data/meta/<table>.json`) into the SQLite table of the same name.
 * Only runs when the SQLite table is still empty — never overwrites rows
 * that already exist there, so it's safe to call unconditionally on every
 * startup (idempotent after the first successful run). The legacy JSON
 * file is renamed to `<name>.json.migrated` rather than deleted, so a
 * failed/partial migration is recoverable and no pre-existing data is
 * silently discarded.
 */
export async function migrateJsonFileIfPresent<T>(jsonFilePath: string, sqliteIndex: SqliteIndex<T>): Promise<{ migrated: number }> {
  let raw: string;
  try {
    raw = await fs.readFile(jsonFilePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { migrated: 0 };
    throw err;
  }
  if ((await sqliteIndex.count()) > 0) return { migrated: 0 }; // already migrated (or SQLite already has independent data)
  const entries = JSON.parse(raw) as [string, T][];
  for (const [id, value] of entries) {
    await sqliteIndex.set(id, value);
  }
  await fs.rename(jsonFilePath, `${jsonFilePath}.migrated`);
  return { migrated: entries.length };
}

/** Test-only: drops every cached connection so a fresh `new SqliteIndex()`
 * in the next test reopens the (possibly newly created temp) file instead
 * of reusing a stale handle from an earlier test's now-deleted temp dir. */
export function _closeAllForTests(): void {
  for (const db of openDatabases.values()) db.close();
  openDatabases.clear();
}

/** Absolute path helper so callers don't hand-assemble `path.join`s that
 * drift from where this module actually expects the legacy file to be. */
export function legacyJsonPathFor(metaDir: string, tableName: string): string {
  return path.join(metaDir, `${tableName}.json`);
}
