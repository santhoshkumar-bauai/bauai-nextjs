import { randomUUID } from "node:crypto";

import { ObjectId } from "mongodb";
import { z } from "zod";

import { getGateway } from "@/lib/ai/gateway";
import { hybridRetrieveChunks, hybridRetrieveCompanyChunks } from "@/lib/ai/retrieval/hybrid";
import { resolveRole } from "@/lib/ai/gateway/config";
import { DocumentAiUsage } from "@/models/document-ai-usage";
import type { WorkspaceDocumentDocument } from "@/models/workspace-document";
import type { HydratedDocument } from "mongoose";

import { aiProposalSchema, type AiOperationRequest } from "./ai-schema";

function contextText(input: AiOperationRequest): string {
  return [
    input.context.selection ? `Selection:\n${input.context.selection}` : "",
    ...input.context.items.map((item) =>
      `Target ${item.id}${item.sheet ? ` (${item.sheet}!${item.range})` : ""}: ${item.value}`,
    ),
  ].filter(Boolean).join("\n\n").slice(0, 60_000);
}

export async function generateDocumentProposal(input: {
  request: AiOperationRequest;
  document: HydratedDocument<WorkspaceDocumentDocument>;
  companyId: ObjectId;
  userId: string;
}) {
  const started = Date.now();
  const requestId = randomUUID();
  const query = input.request.instruction || input.request.context.selection || "tender form requirements";
  const [tenderEvidence, companyEvidence] = await Promise.all([
    input.document.tenderId
      ? hybridRetrieveChunks({
          text: query,
          mode: "hybrid",
          k: 6,
          filters: {
            tenantId: null,
            tenderId: new ObjectId(String(input.document.tenderId)),
          },
        }).catch(() => [])
      : Promise.resolve([]),
    hybridRetrieveCompanyChunks({
      text: query,
      k: 6,
      filters: { tenantId: input.companyId },
    }).catch(() => []),
  ]);
  const evidence = [...tenderEvidence, ...companyEvidence].map((chunk, index) => ({
    id: `e${index + 1}`,
    label: chunk.fileName,
    text: chunk.text.slice(0, 2_000),
  }));
  const prompt = `You are Clara, BAU AI's tender-document assistant. Produce safe, reviewable structured edits only.

Task: ${input.request.task}
Instruction: ${input.request.instruction || "Use the supplied evidence to complete or review the selected targets."}
Document type: ${input.document.documentType}

Rules:
- Only target identifiers/ranges supplied in Editor context.
- Copy the target's expectedHash exactly into every operation.
- Do not guess a target. Omit an operation when evidence is insufficient.
- Use action replace/comment for Word, setCell for spreadsheet cells, and setForm for forms.
- Cite only evidence IDs listed below. Selection-only rewrites may cite sourceId "document".

Editor context:
${contextText(input.request)}

Evidence:
${evidence.length ? evidence.map((item) => `[${item.id}] ${item.label}\n${item.text}`).join("\n\n") : "No retrieved evidence. Use only the supplied document context."}`;

  const model = resolveRole("reasoning");
  try {
    const result = await getGateway().generateStructured({
      role: "reasoning",
      prompt,
      schema: z.toJSONSchema(aiProposalSchema) as Record<string, unknown>,
      zod: aiProposalSchema,
      temperature: 0,
    });
    const allowedIds = new Set(["document", ...evidence.map((item) => item.id)]);
    const value = {
      operations: result.value.operations.map((operation) => ({
        ...operation,
        citations: operation.citations.filter((citation) => allowedIds.has(citation.sourceId)),
      })),
    };
    await DocumentAiUsage.create({
      companyId: input.document.companyId,
      userId: input.userId,
      documentId: input.document._id,
      operation: input.request.task,
      provider: result.provider,
      model: result.model,
      requestId,
      durationMs: Date.now() - started,
      outcome: "success",
    });
    return { requestId, proposal: value };
  } catch (error) {
    await DocumentAiUsage.create({
      companyId: input.document.companyId,
      userId: input.userId,
      documentId: input.document._id,
      operation: input.request.task,
      provider: model.provider,
      model: model.model,
      requestId,
      durationMs: Date.now() - started,
      outcome: "error",
    }).catch(() => undefined);
    throw error;
  }
}
