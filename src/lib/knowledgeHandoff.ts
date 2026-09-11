import type { FileRecord, JobRecord } from "./store.js";

/**
 * Builds a proposal shaped for `rheinagent-knowledge-mcp`'s own
 * `knowledge_contribution_create` tool — NOT a call to Knowledge itself.
 * This product has no Knowledge credential, no Knowledge tenant identity,
 * and no way to know which data scopes the *calling* principal has been
 * granted there (see docs/KNOWLEDGE-INTEGRATION.md). The caller (a human
 * or an agent acting with the user's own Knowledge-side identity) takes
 * this proposal and calls Knowledge's contribution/review/publish flow
 * themselves — this repo never bypasses that flow.
 *
 * Verified against rheinagent-knowledge-mcp's actual `main` (2026-09-11):
 * `knowledge_contribution_create` accepts exactly
 * `{topic, department, scope, answers[], statements[]}` — there is no
 * title/content/tags/classification field on create at all (those only
 * exist later, as document metadata set after indexing/publication).
 * `scope` must be one of the *calling principal's* already-granted data
 * scopes (`contributionScopeAllowed()` on the Knowledge side) — inventing
 * one here would either be rejected there or, worse, accidentally match a
 * scope this file was never authorized for. `department` has no
 * discoverable source of truth in this product at all. Both come back
 * `null` with an entry in `requires_user_input`, never guessed.
 */

const MAX_STATEMENTS = 100; // Knowledge's own contribution_create limit
const MAX_STATEMENT_CHARS = 5000; // Knowledge's own per-statement limit

export interface KnowledgeHandoffSource {
  file_id: string;
  sha256: string;
  mime_category: string;
  original_filename: string;
}

export interface KnowledgeContributionProposal {
  topic: string | null;
  department: string | null;
  scope: string | null;
  answers: never[];
  statements: { text: string }[];
}

export interface KnowledgeHandoffResult {
  target: "knowledge";
  source: KnowledgeHandoffSource;
  contribution: KnowledgeContributionProposal;
  requires_user_input: string[];
  warnings: string[];
  ready: boolean;
}

/**
 * Splits `text` into Knowledge-sized statement chunks on paragraph
 * boundaries where possible (keeps each statement a coherent unit rather
 * than an arbitrary character cut), falling back to a hard character
 * split for a single paragraph longer than the limit. Bounded to
 * `MAX_STATEMENTS` — the caller is told via the returned `truncated` flag
 * if real content had to be dropped, never silently.
 */
export function chunkTextIntoStatements(text: string): { statements: { text: string }[]; truncated: boolean } {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const statements: { text: string }[] = [];
  let truncated = false;

  const pushChunked = (chunk: string) => {
    for (let i = 0; i < chunk.length; i += MAX_STATEMENT_CHARS) {
      if (statements.length >= MAX_STATEMENTS) {
        truncated = true;
        return;
      }
      statements.push({ text: chunk.slice(i, i + MAX_STATEMENT_CHARS) });
    }
  };

  for (const paragraph of paragraphs) {
    if (statements.length >= MAX_STATEMENTS) {
      truncated = true;
      break;
    }
    pushChunked(paragraph);
  }
  return { statements, truncated };
}

/** Pulls a best-effort text field out of whatever shape a processor's
 * result happens to have — different extraction processors name it
 * differently, all deliberately called `text` (see docs/PROCESSORS.md) so
 * this stays a single, simple lookup rather than per-processor logic. */
function extractTextFromJobResult(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const text = (result as Record<string, unknown>).text;
  return typeof text === "string" && text.length > 0 ? text : null;
}

export function buildKnowledgeHandoffProposal(
  file: FileRecord,
  extractionJob: JobRecord | null,
  extractionJobResult: unknown,
): KnowledgeHandoffResult {
  const warnings: string[] = [];
  const requiresUserInput = ["department", "scope"];

  let statements: { text: string }[] = [];
  if (extractionJob) {
    if (extractionJob.state !== "completed") {
      warnings.push(`extraction_job_id ${extractionJob.jobId} is not completed (state: "${extractionJob.state}") — no content included`);
    } else {
      const text = extractTextFromJobResult(extractionJobResult);
      if (text === null) {
        warnings.push(`extraction_job_id ${extractionJob.jobId}'s result has no usable "text" field — no content included`);
      } else {
        const chunked = chunkTextIntoStatements(text);
        statements = chunked.statements;
        if (chunked.truncated) warnings.push(`content exceeded Knowledge's ${MAX_STATEMENTS}-statement limit — truncated`);
      }
    }
  } else {
    warnings.push("no extraction_job_id given — pass a completed extraction job's job_id (e.g. from text_extract/docx_extract_text/pdf_extract_text) to include content as statements");
  }

  return {
    target: "knowledge",
    source: {
      file_id: file.fileId,
      sha256: file.sha256,
      mime_category: file.mimeCategory,
      original_filename: file.filename,
    },
    contribution: {
      topic: file.filename,
      department: null,
      scope: null,
      answers: [],
      statements,
    },
    requires_user_input: requiresUserInput,
    warnings,
    // Never "ready to submit" on its own — department/scope always need a
    // human/agent decision (see the module docstring). `ready` here only
    // says "this proposal carries real content", not "safe to auto-submit".
    ready: statements.length > 0,
  };
}
