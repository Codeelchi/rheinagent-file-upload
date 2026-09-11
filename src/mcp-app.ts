import { App } from "@modelcontextprotocol/ext-apps";

const dropEl = document.getElementById("drop")!;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const statusEl = document.getElementById("status")!;
const doclistEl = document.getElementById("doclist")!;
const viewerEl = document.getElementById("viewer")!;
const viewerTitleEl = document.getElementById("viewer-title")!;
const viewerContentEl = document.getElementById("viewer-content")!;
const downloadBtn = document.getElementById("download-btn") as HTMLButtonElement;
const summarizeBtn = document.getElementById("summarize-btn") as HTMLButtonElement;

type DocSummary = { id: string; filename: string; length: number };

let currentView: { id: string; filename: string; content: string } | null = null;

const app = new App({ name: "RheinAgent Document Workbench", version: "1.1.0" });

function renderList(docs: DocSummary[]) {
  doclistEl.innerHTML = "";
  if (!docs.length) {
    if (!currentView) viewerEl.style.display = "none";
    return;
  }
  for (const d of docs) {
    const row = document.createElement("div");
    row.className = "doc-row";
    const label = document.createElement("span");
    label.textContent = `${d.filename} (${d.length} Zeichen)`;
    const actions = document.createElement("span");
    actions.className = "doc-actions";
    const viewBtn = document.createElement("button");
    viewBtn.textContent = "Ansehen";
    viewBtn.onclick = () => viewDocument(d.id);
    const delBtn = document.createElement("button");
    delBtn.textContent = "Löschen";
    delBtn.className = "danger";
    delBtn.onclick = () => deleteDocument(d.id);
    actions.appendChild(viewBtn);
    actions.appendChild(delBtn);
    row.appendChild(label);
    row.appendChild(actions);
    doclistEl.appendChild(row);
  }
}

function renderViewer(id: string, filename: string, content: string) {
  currentView = { id, filename, content };
  viewerEl.style.display = "block";
  viewerTitleEl.textContent = filename;
  viewerContentEl.textContent = content;
}

// Central handler: applies to results from the widget's own calls AND to
// results the host pushes when the LLM calls one of our tools directly.
function applyResult(structuredContent: unknown) {
  if (!structuredContent || typeof structuredContent !== "object") return;
  const sc = structuredContent as Record<string, unknown>;
  switch (sc.action) {
    case "uploaded":
      statusEl.textContent = `"${sc.filename}" hochgeladen (${sc.length} Zeichen).`;
      refreshList();
      break;
    case "list":
      renderList((sc.documents as DocSummary[]) ?? []);
      if (currentView && !(sc.documents as DocSummary[])?.some((d) => d.id === currentView!.id)) {
        currentView = null;
        viewerEl.style.display = "none";
      }
      break;
    case "view":
    case "edited":
      renderViewer(sc.id as string, sc.filename as string, sc.content as string);
      if (sc.action === "edited") {
        statusEl.textContent = `"${sc.filename}" wurde bearbeitet.`;
      }
      break;
  }
}

async function refreshList() {
  const result = await app.callServerTool({ name: "list_documents", arguments: {} });
  applyResult(result.structuredContent);
}

async function viewDocument(id: string) {
  const result = await app.callServerTool({ name: "get_document", arguments: { id } });
  applyResult(result.structuredContent);
}

async function deleteDocument(id: string) {
  const result = await app.callServerTool({ name: "delete_document", arguments: { id } });
  applyResult(result.structuredContent);
  statusEl.textContent = "Dokument gelöscht.";
}

async function uploadOne(file: File) {
  const content = await file.text();
  const uploadResult = await app.callServerTool({
    name: "upload_document",
    arguments: { filename: file.name, content },
  });
  applyResult(uploadResult.structuredContent);
  return content;
}

async function handleFiles(files: File[]) {
  statusEl.textContent = `Lade ${files.length} Datei(en) hoch ...`;
  const uploaded: { name: string; content: string }[] = [];
  for (const file of files) {
    const content = await uploadOne(file);
    uploaded.push({ name: file.name, content });
  }

  if (app.getHostCapabilities()?.updateModelContext) {
    const combined = uploaded
      .map((u) => `Hochgeladenes Dokument "${u.name}":\n\n${u.content}`)
      .join("\n\n---\n\n");
    await app.updateModelContext({ content: [{ type: "text", text: combined }] });
    const names = uploaded.map((u) => `"${u.name}"`).join(", ");
    await app.sendMessage({
      role: "user",
      content: [{ type: "text", text: `Fasse das/die Dokument(e) ${names} jeweils in 3 Sätzen zusammen.` }],
    });
  } else {
    statusEl.textContent += "\n(Host unterstützt updateModelContext nicht.)";
  }
}

summarizeBtn.addEventListener("click", async () => {
  if (!currentView) return;
  if (app.getHostCapabilities()?.updateModelContext) {
    await app.updateModelContext({
      content: [
        {
          type: "text",
          text: `Aktueller Inhalt von "${currentView.filename}":\n\n${currentView.content}`,
        },
      ],
    });
    await app.sendMessage({
      role: "user",
      content: [{ type: "text", text: `Fasse "${currentView.filename}" in 3 Sätzen zusammen.` }],
    });
    statusEl.textContent = `Zusammenfassung von "${currentView.filename}" angefordert.`;
  } else {
    statusEl.textContent = "Host unterstützt updateModelContext nicht.";
  }
});

downloadBtn.addEventListener("click", async () => {
  if (!currentView) return;
  const { isError } = await app.downloadFile({
    contents: [
      {
        type: "resource",
        resource: {
          uri: `file:///${currentView.filename}`,
          mimeType: "text/plain",
          text: currentView.content,
        },
      },
    ],
  });
  if (isError) statusEl.textContent = "Download abgelehnt oder abgebrochen.";
});

dropEl.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const files = Array.from(fileInput.files ?? []);
  if (files.length) handleFiles(files).catch((err) => (statusEl.textContent = `Fehler: ${err}`));
});
dropEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropEl.classList.add("dragover");
});
dropEl.addEventListener("dragleave", () => dropEl.classList.remove("dragover"));
dropEl.addEventListener("drop", (e) => {
  e.preventDefault();
  dropEl.classList.remove("dragover");
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length) handleFiles(files).catch((err) => (statusEl.textContent = `Fehler: ${err}`));
});

// When the LLM calls one of our tools directly from the chat (not via this
// widget's own buttons), the host pushes the result here so the UI stays in sync.
app.addEventListener("toolresult", (params) => {
  applyResult(params.structuredContent);
});

app.connect();
