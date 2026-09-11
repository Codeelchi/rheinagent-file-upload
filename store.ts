import fs from "node:fs/promises";
import path from "node:path";

export type StoredDocument = { id: string; filename: string; content: string };

const DATA_DIR = path.join(import.meta.dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "documents.json");

const documents = new Map<string, StoredDocument>();

async function persist(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify([...documents.values()], null, 2), "utf-8");
}

export async function loadStore(): Promise<void> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    const list = JSON.parse(raw) as StoredDocument[];
    for (const doc of list) documents.set(doc.id, doc);
    console.log(`Loaded ${list.length} document(s) from ${DATA_FILE}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function docSummary(d: StoredDocument) {
  return { id: d.id, filename: d.filename, length: d.content.length };
}

export async function upsertDocument(doc: StoredDocument): Promise<void> {
  documents.set(doc.id, doc);
  await persist();
}

export function getDocument(id: string): StoredDocument | undefined {
  return documents.get(id);
}

export function listDocuments(): StoredDocument[] {
  return [...documents.values()];
}

export async function deleteDocument(id: string): Promise<boolean> {
  const existed = documents.delete(id);
  if (existed) await persist();
  return existed;
}
