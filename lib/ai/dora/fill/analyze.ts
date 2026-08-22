import { ObjectId } from "mongodb";

import { getChatModel } from "@/lib/ai/agent/model";
import { getAiCollections } from "@/lib/ai/db/collections";
import { getDoraSnapshot } from "@/lib/dora-gateway/snapshots";
import { WorkspaceDocument } from "@/models/workspace-document";

import { fillRunFormat } from "./format";
import { buildFillGrounding } from "./grounding";
import { resolveDiscoveredFields } from "./resolve";
import { FILL_DISCOVERY_JSON_SCHEMA, fillDiscoverySchema } from "./schema";
import { updateFillRun } from "./runs";

/**
 * Analyse a fill run with whichever engine its format calls for.
 *
 * The format is read from the RUN, never from the job payload: a queued job
 * that is retried after the run was edited must dispatch on current state, not
 * on a snapshot of it taken at enqueue time. That is also why OnlyOfficeJob
 * still carries nothing but a runId.
 *
 * The PDF graph (pdf-lib, unpdf) is imported lazily so a Word run never pays
 * for loading it.
 */
export async function analyzeFillRun(runIdHex: string): Promise<void> {
  const { documentFillRuns } = await getAiCollections();
  const run = await documentFillRuns.findOne(
    { _id: new ObjectId(runIdHex) },
    { projection: { format: 1 } },
  );
  if (!run) return;
  if (fillRunFormat(run) === "pdf") {
    const { analyzePdfFillRun } = await import("./pdf/analyze-pdf");
    return analyzePdfFillRun(runIdHex);
  }
  return analyzeDocumentFillRun(runIdHex);
}

export async function analyzeDocumentFillRun(runIdHex: string): Promise<void> {
  const { documentFillRuns } = await getAiCollections();
  const runId = new ObjectId(runIdHex);
  const run = await documentFillRuns.findOne({ _id: runId });
  if (!run || !["queued", "failed"].includes(run.status)) return;
  await updateFillRun(runId, { status: "analyzing", stage: "discovering", error: null });

  try {
    if (!run.snapshotId) throw new Error("snapshot_expired");
    const [snapshot, document] = await Promise.all([
      getDoraSnapshot({
        snapshotId: run.snapshotId,
        tenantId: run.tenantId.toHexString(),
        documentId: run.documentId.toHexString(),
        userId: run.startedByUserId,
      }),
      WorkspaceDocument.findById(run.documentId).lean(),
    ]);
    if (!snapshot) throw new Error("snapshot_expired");
    if (!document) throw new Error("document_context_missing");
    if (snapshot.snapshotHash !== run.snapshotHash) throw new Error("snapshot_hash_mismatch");

    await updateFillRun(runId, { stage: "grounding" });
    const { evidence, profileLines, corpusLines } = await buildFillGrounding({
      tenantId: run.tenantId,
      tenderId: document.tenderId ? new ObjectId(String(document.tenderId)) : null,
    });

    const nodes = snapshot.nodes.map((node) => ({
      id: node.id,
      path: node.path,
      surface: node.surface,
      kind: node.kind,
      text: node.text,
      editable: node.editable,
      protectedReason: node.protectedReason,
      formKey: node.formKey ?? null,
    }));
    const prompt = [
      "You discover fillable business-document fields. Return only fields that visibly exist in the supplied Word snapshot.",
      "Use nodeId exactly. targetText must be the exact, smallest placeholder text to replace and must occur in that node; for native forms it may be empty.",
      "Never invent values. A value needs one or more exact evidenceReferences from the supplied keys.",
      "Mark signatures, initials, attestations, consent, bank details, certifications, and binding commitments as sensitive.",
      "Blank areas without a stable native form key or exact placeholder are still fields, but leave targetText empty so deterministic validation can hold them for review.",
      `DOCUMENT NODES:\n${JSON.stringify(nodes)}`,
      `STRUCTURED COMPANY PROFILE:\n${profileLines.join("\n") || "(none)"}`,
      `RELEVANT DOCUMENT EVIDENCE:\n${corpusLines.join("\n") || "(none)"}`,
    ].join("\n\n");

    const model = await getChatModel({ role: "dora_fill", maxOutputTokens: 16_384, temperature: 0 });
    const structured = model.withStructuredOutput(FILL_DISCOVERY_JSON_SCHEMA as never, {
      name: "document_fill_discovery",
    });
    const raw = await structured.invoke(prompt);
    const discovery = fillDiscoverySchema.parse(raw);
    await updateFillRun(runId, { stage: "validating" });
    const fields = resolveDiscoveredFields({ discovery, snapshot, evidence });
    await updateFillRun(runId, { status: "review", stage: "review", fields });
  } catch (error) {
    await updateFillRun(runId, {
      status: "failed",
      error: (error instanceof Error ? error.message : "analysis_failed").slice(0, 500),
      finishedAt: new Date(),
    });
    throw error;
  }
}
