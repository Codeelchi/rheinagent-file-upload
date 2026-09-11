console.log("Starting MCP UI test server...");

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import cors from "cors";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const server = new McpServer({
  name: "RheinAgent Document Workbench Test Server",
  version: "1.0.0",
});

const resourceUri = "ui://documents/mcp-app.html";
const ui = { ui: { resourceUri } };

type StoredDocument = { id: string; filename: string; content: string };
const documents = new Map<string, StoredDocument>();

function docSummary(d: StoredDocument) {
  return { id: d.id, filename: d.filename, length: d.content.length };
}

registerAppTool(
  server,
  "upload_document",
  {
    title: "Dokument hochladen",
    description:
      "Nimmt ein im Widget hochgeladenes Text-Dokument entgegen und speichert es serverseitig.",
    inputSchema: { filename: z.string(), content: z.string() },
    _meta: ui,
  },
  async ({ filename, content }) => {
    const id = `${Date.now()}-${filename}`;
    const doc: StoredDocument = { id, filename, content };
    documents.set(id, doc);
    return {
      content: [
        { type: "text", text: `Dokument "${filename}" hochgeladen (${content.length} Zeichen).` },
      ],
      structuredContent: { action: "uploaded", ...docSummary(doc) },
    };
  },
);

registerAppTool(
  server,
  "list_documents",
  {
    title: "Dokumente auflisten",
    description: "Listet alle aktuell auf dem Server gespeicherten Dokumente.",
    inputSchema: {},
    _meta: ui,
  },
  async () => {
    const list = [...documents.values()].map(docSummary);
    return {
      content: [
        {
          type: "text",
          text: list.length
            ? `${list.length} Dokument(e) gespeichert: ${list.map((d) => d.filename).join(", ")}`
            : "Keine Dokumente gespeichert.",
        },
      ],
      structuredContent: { action: "list", documents: list },
    };
  },
);

registerAppTool(
  server,
  "get_document",
  {
    title: "Dokument anzeigen",
    description: "Liest den vollständigen Inhalt eines gespeicherten Dokuments.",
    inputSchema: { id: z.string() },
    _meta: ui,
  },
  async ({ id }) => {
    const doc = documents.get(id);
    if (!doc) {
      return { content: [{ type: "text", text: `Dokument ${id} nicht gefunden.` }], isError: true };
    }
    return {
      content: [{ type: "text", text: doc.content }],
      structuredContent: { action: "view", ...docSummary(doc), content: doc.content },
    };
  },
);

registerAppTool(
  server,
  "edit_document",
  {
    title: "Dokument bearbeiten",
    description:
      "Ersetzt den Inhalt eines gespeicherten Dokuments durch neuen, vom LLM erzeugten Text.",
    inputSchema: { id: z.string(), newContent: z.string() },
    _meta: ui,
  },
  async ({ id, newContent }) => {
    const doc = documents.get(id);
    if (!doc) {
      return { content: [{ type: "text", text: `Dokument ${id} nicht gefunden.` }], isError: true };
    }
    doc.content = newContent;
    documents.set(id, doc);
    return {
      content: [
        { type: "text", text: `Dokument "${doc.filename}" wurde aktualisiert (${newContent.length} Zeichen).` },
      ],
      structuredContent: { action: "edited", ...docSummary(doc), content: doc.content },
    };
  },
);

registerAppTool(
  server,
  "delete_document",
  {
    title: "Dokument löschen",
    description: "Entfernt ein gespeichertes Dokument endgültig vom Server.",
    inputSchema: { id: z.string() },
    _meta: ui,
  },
  async ({ id }) => {
    const doc = documents.get(id);
    if (!doc) {
      return { content: [{ type: "text", text: `Dokument ${id} nicht gefunden.` }], isError: true };
    }
    documents.delete(id);
    const list = [...documents.values()].map(docSummary);
    return {
      content: [{ type: "text", text: `Dokument "${doc.filename}" wurde gelöscht.` }],
      structuredContent: { action: "list", documents: list },
    };
  },
);

registerAppResource(
  server,
  resourceUri,
  resourceUri,
  { mimeType: RESOURCE_MIME_TYPE },
  async () => {
    const html = await fs.readFile(
      path.join(import.meta.dirname, "dist", "mcp-app.html"),
      "utf-8",
    );
    return {
      contents: [
        { uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html },
      ],
    };
  },
);

const expressApp = express();
expressApp.use(cors());
expressApp.use(express.json());

expressApp.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = 3901;
expressApp.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}/mcp`);
});
