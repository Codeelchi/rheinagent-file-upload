import fs from "node:fs/promises";

/**
 * Server-side processor registry. There is no generic "run a command" or
 * "execute this code" tool anywhere in this product — a processor is a
 * fixed, named TypeScript function registered here at build time. Adding
 * capability means adding a registry entry and shipping a new release, not
 * accepting arbitrary code/shell input from an MCP client.
 */

export interface ProcessorContext {
  filePath: string;
  filename: string;
  mimeCategory: string;
}

export type Processor = (ctx: ProcessorContext) => Promise<Record<string, unknown>>;

const registry = new Map<string, Processor>();

function register(id: string, fn: Processor): void {
  registry.set(id, fn);
}

export function getProcessor(id: string): Processor | undefined {
  return registry.get(id);
}

export function listProcessorIds(): string[] {
  return [...registry.keys()];
}

register("text_stats", async (ctx) => {
  if (ctx.mimeCategory !== "text") {
    throw new Error("text_stats only supports text documents");
  }
  const content = await fs.readFile(ctx.filePath, "utf-8");
  const lines = content.split(/\r?\n/);
  const words = content.split(/\s+/).filter(Boolean);
  return {
    line_count: lines.length,
    word_count: words.length,
    char_count: content.length,
  };
});

register("text_uppercase", async (ctx) => {
  if (ctx.mimeCategory !== "text") {
    throw new Error("text_uppercase only supports text documents");
  }
  const content = await fs.readFile(ctx.filePath, "utf-8");
  return { transformed_text: content.toUpperCase() };
});
