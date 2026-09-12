import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkTextIntoStatements, buildKnowledgeHandoffProposal } from "../src/lib/knowledgeHandoff.js";
import type { FileRecord, JobRecord } from "../src/lib/store.js";

// Proposal-building for rheinagent-knowledge-mcp's own knowledge_contribution_create
// tool — never a call to Knowledge itself, never an invented scope/department.

function makeFile(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    fileId: "file_11111111-1111-1111-1111-111111111111",
    filename: "report.txt",
    sizeBytes: 100,
    mimeCategory: "text",
    sha256: "a".repeat(64),
    createdAt: new Date().toISOString(),
    pendingDelete: false,
    ...overrides,
  };
}

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: "job_22222222-2222-2222-2222-222222222222",
    fileId: "file_11111111-1111-1111-1111-111111111111",
    processorId: "text_extract",
    state: "completed",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test("chunkTextIntoStatements splits on paragraph boundaries", () => {
  const text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
  const { statements, truncated } = chunkTextIntoStatements(text);
  assert.deepEqual(
    statements.map((s) => s.text),
    ["First paragraph.", "Second paragraph.", "Third paragraph."],
  );
  assert.equal(truncated, false);
});

test("chunkTextIntoStatements hard-splits a single paragraph longer than the per-statement limit", () => {
  const long = "x".repeat(12_000);
  const { statements, truncated } = chunkTextIntoStatements(long);
  assert.equal(statements.length, 3); // 12000 / 5000 -> 3 chunks (5000+5000+2000)
  assert.equal(statements[0].text.length, 5000);
  assert.equal(statements[2].text.length, 2000);
  assert.equal(truncated, false);
});

test("chunkTextIntoStatements caps at 100 statements and reports truncated", () => {
  const paragraphs = Array.from({ length: 150 }, (_, i) => `paragraph ${i}`).join("\n\n");
  const { statements, truncated } = chunkTextIntoStatements(paragraphs);
  assert.equal(statements.length, 100);
  assert.equal(truncated, true);
});

test("buildKnowledgeHandoffProposal without an extraction job: no content, explains why", () => {
  const proposal = buildKnowledgeHandoffProposal(makeFile(), null, undefined);
  assert.equal(proposal.ready, false);
  assert.deepEqual(proposal.contribution.statements, []);
  assert.deepEqual(proposal.contribution.answers, []);
  assert.equal(proposal.contribution.department, null);
  assert.equal(proposal.contribution.scope, null);
  assert.deepEqual(proposal.requires_user_input, ["department", "scope"]);
  assert.match(proposal.warnings[0], /no extraction_job_id given/);
});

test("buildKnowledgeHandoffProposal never invents department/scope, even with rich content", () => {
  const job = makeJob();
  const proposal = buildKnowledgeHandoffProposal(makeFile(), job, { text: "Some extracted content.\n\nMore content." });
  assert.equal(proposal.contribution.department, null);
  assert.equal(proposal.contribution.scope, null);
  assert.ok(proposal.requires_user_input.includes("department"));
  assert.ok(proposal.requires_user_input.includes("scope"));
});

test("buildKnowledgeHandoffProposal populates statements from a completed job's text result", () => {
  const job = makeJob();
  const proposal = buildKnowledgeHandoffProposal(makeFile(), job, { text: "Paragraph one.\n\nParagraph two.", paragraph_count: 2 });
  assert.equal(proposal.ready, true);
  assert.deepEqual(
    proposal.contribution.statements.map((s) => s.text),
    ["Paragraph one.", "Paragraph two."],
  );
  assert.equal(proposal.warnings.length, 0);
});

test("buildKnowledgeHandoffProposal warns and includes no content when the job isn't completed", () => {
  const job = makeJob({ state: "prepared" });
  const proposal = buildKnowledgeHandoffProposal(makeFile(), job, undefined);
  assert.equal(proposal.ready, false);
  assert.deepEqual(proposal.contribution.statements, []);
  assert.match(proposal.warnings[0], /not completed/);
});

test("buildKnowledgeHandoffProposal warns when the job's result has no usable text field", () => {
  const job = makeJob({ processorId: "csv_inspect" });
  const proposal = buildKnowledgeHandoffProposal(makeFile(), job, { row_count: 5, headers: ["a", "b"] });
  assert.equal(proposal.ready, false);
  assert.match(proposal.warnings[0], /no usable "text" field/);
});

test("buildKnowledgeHandoffProposal uses the filename as the suggested topic, never invents one", () => {
  const proposal = buildKnowledgeHandoffProposal(makeFile({ filename: "Q3-Report.pdf" }), null, undefined);
  assert.equal(proposal.contribution.topic, "Q3-Report.pdf");
});

test("buildKnowledgeHandoffProposal source carries file identity for traceability", () => {
  const file = makeFile({ sha256: "b".repeat(64), mimeCategory: "pdf" });
  const proposal = buildKnowledgeHandoffProposal(file, null, undefined);
  assert.deepEqual(proposal.source, {
    file_id: file.fileId,
    sha256: file.sha256,
    mime_category: "pdf",
    original_filename: file.filename,
  });
});
