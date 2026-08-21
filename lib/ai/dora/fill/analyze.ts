import { ObjectId } from "mongodb";

import { getChatModel } from "@/lib/ai/agent/model";
import { getAiCollections } from "@/lib/ai/db/collections";
import { getDoraSnapshot } from "@/lib/dora-gateway/snapshots";
import { Company } from "@/models/company";
import { WorkspaceDocument } from "@/models/workspace-document";

import { resolveDiscoveredFields } from "./resolve";
import { FILL_DISCOVERY_JSON_SCHEMA, fillDiscoverySchema } from "./schema";
import { updateFillRun } from "./runs";
import type { DocumentFillEvidence } from "./types";

function flatten(value: unknown, prefix = "company", out = new Map<string, string>()) {
  if (value == null) return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${prefix}.${index}`, out));
  } else if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!["_id", "members", "membershipRequests", "trial", "createdBy", "createdAt", "updatedAt"].includes(key)) {
        flatten(item, `${prefix}.${key}`, out);
      }
    }
  } else if (String(value).trim()) {
    out.set(prefix, String(value).trim());
  }
  return out;
}

export async function analyzeDocumentFillRun(runIdHex: string): Promise<void> {
  const { documentFillRuns, chunks } = await getAiCollections();
  const runId = new ObjectId(runIdHex);
  const run = await documentFillRuns.findOne({ _id: runId });
  if (!run || !["queued", "failed"].includes(run.status)) return;
  await updateFillRun(runId, { status: "analyzing", stage: "discovering", error: null });

  try {
    const [snapshot, company, document] = await Promise.all([
      getDoraSnapshot({
        snapshotId: run.snapshotId,
        tenantId: run.tenantId.toHexString(),
        documentId: run.documentId.toHexString(),
        userId: run.startedByUserId,
      }),
      Company.findById(run.tenantId).lean(),
      WorkspaceDocument.findById(run.documentId).lean(),
    ]);
    if (!snapshot) throw new Error("snapshot_expired");
    if (!company || !document) throw new Error("document_context_missing");
    if (snapshot.snapshotHash !== run.snapshotHash) throw new Error("snapshot_hash_mismatch");

    await updateFillRun(runId, { stage: "grounding" });
    const profile = flatten(company);
    const evidence = new Map<string, DocumentFillEvidence>();
    const profileLines = [...profile.entries()].map(([key, value]) => {
      evidence.set(key, { source: "company_profile", reference: key, excerpt: value.slice(0, 240) });
      return `${key}: ${value}`;
    });
    const corpus = await chunks
      .find({
        $or: [
          { tenantId: run.tenantId },
          ...(document.tenderId ? [{ tenantId: null, tenderId: new ObjectId(String(document.tenderId)) }] : []),
        ],
      })
      .sort({ chunkIndex: 1 })
      .limit(40)
      .toArray();
    const corpusLines = corpus.map((chunk) => {
      const ref = `chunk:${chunk._id?.toHexString() ?? `${chunk.documentRecordId}:${chunk.chunkIndex}`}`;
      evidence.set(ref, {
        source: chunk.tenantId ? "company_document" : "tender",
        reference: ref,
        excerpt: chunk.text.slice(0, 240),
      });
      return `${ref} (${chunk.fileName}, ${chunk.sectionPath.join(" > ")}): ${chunk.text}`;
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
