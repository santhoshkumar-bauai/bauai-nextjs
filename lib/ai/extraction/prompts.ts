import type { ExtractionSchemaEntry } from "./schemas/index.ts";

/**
 * Prompt builders for structured extraction. `PROMPT_VERSION` is part of the
 * extraction idempotency key — bump it on any wording change so affected
 * tenders re-extract.
 */
export const PROMPT_VERSION = "p1";

export interface ChunkBlock {
  kind: "chunk";
  chunkId: string;
  sectionPath: string[];
  text: string;
}

export interface DocumentBlock {
  kind: "document";
  documentRecordId: string;
  fileName: string;
  text: string;
}

export type SourceBlock = ChunkBlock | DocumentBlock;

function renderBlock(block: SourceBlock): string {
  if (block.kind === "chunk") {
    const section = block.sectionPath.length
      ? ` (${block.sectionPath.join(" > ")})`
      : "";
    return `[chunk:${block.chunkId}]${section}\n${block.text}`;
  }
  return `[document:${block.documentRecordId}] ${block.fileName}\n${block.text}`;
}

const RULES = [
  "Rules:",
  "- Extract ONLY facts stated in the excerpts below. Never infer, estimate, or use outside knowledge.",
  "- Every non-null value MUST carry at least one citation: the id of the block it came from and a verbatim quote copied character-for-character from that block, in the original German.",
  '- For [chunk:...] blocks set citations[].chunkId to that id; for [document:...] blocks set chunkId to null.',
  "- A field whose answer is not present in the excerpts gets value null, an empty citations array, and its name listed in `unresolved`. That is a correct answer — an invented value is a defect.",
  "- Dates and datetimes: ISO-8601. When a time is given, include the Europe/Berlin UTC offset (+01:00 or +02:00).",
  "- Numbers: plain numbers without units or thousands separators (German '1.500,50' becomes 1500.5).",
  "- confidence: your certainty (0-1) that the value is correct AND belongs to this field.",
].join("\n");

export function buildExtractionPrompt(input: {
  schema: ExtractionSchemaEntry;
  blocks: SourceBlock[];
}): string {
  return [
    `You extract structured facts from German public-tender documents.`,
    `Task: fill the "${input.schema.name}" schema (German: ${input.schema.germanTerm}).`,
    "",
    RULES,
    "",
    "=== SOURCE EXCERPTS ===",
    ...input.blocks.map(renderBlock),
  ].join("\n\n");
}

/** Follow-up prompt for fields whose citations failed verification. */
export function buildRetryPrompt(input: {
  schema: ExtractionSchemaEntry;
  failedFieldNames: string[];
  blocks: SourceBlock[];
}): string {
  return [
    `You extract structured facts from German public-tender documents.`,
    `Task: re-extract ONLY these fields of the "${input.schema.name}" schema: ${input.failedFieldNames.join(", ")}.`,
    "Your previous quotes could not be found verbatim in the sources.",
    "The quote must be copied CHARACTER-FOR-CHARACTER from an excerpt below — do not paraphrase, translate, fix spelling, or merge sentences.",
    "Leave every other field null with empty citations.",
    "",
    RULES,
    "",
    "=== SOURCE EXCERPTS ===",
    ...input.blocks.map(renderBlock),
  ].join("\n\n");
}
