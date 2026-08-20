import type { StructuredToolInterface } from "@langchain/core/tools";

import type { DoraRunContext } from "../context";
import { buildDoraTools } from "../tools";

const DOCUMENT_ONLY_TOOLS = new Set([
  "get_document_info",
  "get_document_brief",
  "read_current_document",
  "propose_edits",
]);

/** Keep supplementary company/tender retrieval, but never use CSV extraction as live workbook context. */
export function buildDoraSpreadsheetTools(ctx: DoraRunContext): StructuredToolInterface[] {
  return buildDoraTools(ctx).filter((tool) => !DOCUMENT_ONLY_TOOLS.has(tool.name));
}
