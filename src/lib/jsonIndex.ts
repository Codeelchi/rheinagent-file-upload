import fs from "node:fs/promises";
import path from "node:path";

/**
 * Write-through JSON-file index, shared by every metadata table
 * (uploads/files/jobs/deletes). Each index is its own file under data/meta/
 * — kept deliberately simple (no DB dependency) for this first on-prem
 * version; swapping the backing store later does not change the public
 * MCP tool surface.
 *
 * The control plane (server.ts) and data plane (dataplane.ts) are separate
 * OS processes by design (see docs/ARCHITECTURE.md) that both read/write
 * the `uploads` table. An in-process cache would go stale the moment the
 * *other* process appends a record, so every operation here re-reads the
 * file from disk — there is no in-memory cache across calls. At this
 * product's metadata scale (small JSON, not file bytes) that I/O cost is
 * deliberately accepted in exchange for cross-process correctness. A
 * concurrent set()/delete() on the same id from both processes is still a
 * last-write-wins race at this stage — acceptable for v1 single-operator
 * on-prem use, called out as a known limitation in docs/SECURITY.md.
 */
export class JsonIndex<T> {
  constructor(private readonly filePath: string) {}

  private async load(): Promise<Map<string, T>> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const entries = JSON.parse(raw) as [string, T][];
      return new Map(entries);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return new Map();
    }
  }

  private async persist(map: Map<string, T>): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify([...map.entries()], null, 2), "utf-8");
    await fs.rename(tmp, this.filePath); // atomic on the same filesystem
  }

  async get(id: string): Promise<T | undefined> {
    return (await this.load()).get(id);
  }

  async values(): Promise<T[]> {
    return [...(await this.load()).values()];
  }

  async set(id: string, value: T): Promise<void> {
    const map = await this.load();
    map.set(id, value);
    await this.persist(map);
  }

  async delete(id: string): Promise<boolean> {
    const map = await this.load();
    const existed = map.delete(id);
    if (existed) await this.persist(map);
    return existed;
  }
}
