import { createHash } from "node:crypto";

import { HumanMessage } from "@langchain/core/messages";
import { ObjectId } from "mongodb";

import { getChatModel } from "@/lib/ai/agent/model";
import { getAiCollections } from "@/lib/ai/db/collections";
import { connectMongoose } from "@/lib/db/mongoose";
import { getObjectBuffer } from "@/lib/storage/s3";
import { WorkspaceDocument } from "@/models/workspace-document";
import { WorkspaceDocumentVersion } from "@/models/workspace-document-version";

import { buildFillGrounding } from "../grounding";
import { updateFillRun } from "../runs";
import { buildPdfManifest } from "./manifest";
import { helveticaMeasurer } from "./measure";
import { pdfFileBlock, shouldSendPdfNatively } from "./model-input";
import { resolvePdfDiscoveredFields } from "./resolve-pdf";
import { PDF_FILL_DISCOVERY_JSON_SCHEMA, pdfFillDiscoverySchema } from "./schema-pdf";
import { withProviderStructuredOutput } from "../../../agent/structured.ts";

/**
 * PDF field discovery. Mirrors ../analyze.ts stage for stage — the difference
 * is where the document description comes from.
 *
 * Word analysis reads a live editor snapshot, so it must guard against the
 * snapshot going stale. PDF analysis reads the committed S3 bytes, so there is
 * no snapshot, no editor key and no TTL; what it pins instead is sourceSha256
 * (asserted against the bytes it actually fetched) plus the manifest hash,
 * which generation re-derives before writing anything.
 */
export async function analyzePdfFillRun(runIdHex: string): Promise<void> {
  const { documentFillRuns } = await getAiCollections();
  const runId = new ObjectId(runIdHex);
  const run = await documentFillRuns.findOne({ _id: runId });
  // Same re-entrancy guard as Word: a queue retry of an already-advanced run
  // is a no-op rather than a second analysis.
  if (!run || !["queued", "failed"].includes(run.status)) return;
  await updateFillRun(runId, { status: "analyzing", stage: "discovering", error: null });

  try {
    await connectMongoose();
    const [document, version] = await Promise.all([
      WorkspaceDocument.findById(run.documentId).lean(),
      WorkspaceDocumentVersion.findOne({
        _id: run.sourceVersionId,
        documentId: run.documentId,
        state: "committed",
      }).lean(),
    ]);
    if (!document) throw new Error("document_context_missing");
    if (!version) throw new Error("source_version_missing");

    const bytes = await getObjectBuffer(version.s3Key);
    // The run was created against a specific revision; if the object behind it
    // changed, every coordinate we are about to derive is against the wrong
    // document. This is the PDF analogue of snapshot_hash_mismatch.
    if (createHash("sha256").update(bytes).digest("hex") !== run.sourceSha256) {
      throw new Error("source_bytes_changed");
    }

    const manifest = await buildPdfManifest(bytes);
    const native = shouldSendPdfNatively({
      bytes: bytes.byteLength,
      documentClass: manifest.classification.documentClass,
    });

    await updateFillRun(runId, { stage: "grounding" });
    const { evidence, profileLines, corpusLines } = await buildFillGrounding({
      tenantId: run.tenantId,
      tenderId: document.tenderId ? new ObjectId(String(document.tenderId)) : null,
    });

    const prompt = buildDiscoveryPrompt({
      manifest,
      profileLines,
      corpusLines,
      native,
    });

    const model = await getChatModel({
      role: "dora_pdf_fill",
      maxOutputTokens: 16_384,
      temperature: 0,
    });
    const structured = withProviderStructuredOutput(model, PDF_FILL_DISCOVERY_JSON_SCHEMA, {
      name: "pdf_document_fill_discovery",
      role: "dora_pdf_fill",
    });
    // A multimodal turn needs a BaseMessage[]; the text-only path takes the
    // bare string, exactly like the Word analyzer.
    const raw = native
      ? await structured.invoke([
          new HumanMessage({
            // The standard base64 file block is wider than the SDK's own
            // ContentBlock union, which does not model provider file inputs;
            // the adapter accepts it at runtime (probe P2.B).
            content: [
              { type: "text", text: prompt },
              pdfFileBlock(bytes, document.fileName),
            ] as never,
          }),
        ])
      : await structured.invoke(prompt);
    const discovery = pdfFillDiscoverySchema.parse(raw);

    await updateFillRun(runId, { stage: "validating" });
    const fields = resolvePdfDiscoveredFields({
      discovery,
      manifest,
      evidence,
      measureText: await helveticaMeasurer(),
    });
    await updateFillRun(runId, {
      status: "review",
      stage: "review",
      fields,
      pdf: {
        documentClass: manifest.classification.documentClass,
        pageCount: manifest.classification.pageCount,
        pages: manifest.classification.pages.map((page) => ({
          width: page.width,
          height: page.height,
          rotation: page.rotation,
        })),
        manifestHash: manifest.manifestHash,
        acroFieldCount: manifest.classification.acroFieldCount,
        textCharCount: manifest.classification.textCharCount,
        nativeVision: native,
      },
    });
  } catch (error) {
    await updateFillRun(runId, {
      status: "failed",
      error: (error instanceof Error ? error.message : "analysis_failed").slice(0, 500),
      finishedAt: new Date(),
    });
    throw error;
  }
}

/** Exported for the end-to-end probe and for prompt-shape tests. */
export function buildDiscoveryPrompt(input: {
  manifest: Awaited<ReturnType<typeof buildPdfManifest>>;
  profileLines: string[];
  corpusLines: string[];
  native: boolean;
}): string {
  const { manifest } = input;
  const cls = manifest.classification.documentClass;

  // Only the addressable parts go in. Geometry the model cannot be trusted with
  // is withheld: for acroform and overlay_text the real rects come from the
  // manifest at resolution time, so sending them only invites the model to
  // echo a plausible-looking wrong number.
  const acroFields = manifest.acroFields.map((field) => ({
    nodeId: field.nodeId,
    fieldName: field.fieldName,
    fieldType: field.fieldType,
    page: field.page,
    readOnly: field.readOnly,
    required: field.required,
    currentValue: field.currentValue,
    options: field.options,
    maxLength: field.maxLength,
    label: field.nearbyText,
  }));
  const lines = manifest.lines.map((line) => ({
    nodeId: line.nodeId,
    page: line.page,
    text: line.text,
  }));

  return [
    "You discover fillable fields in a procurement document. Return only fields that visibly exist in this PDF.",
    input.native
      ? "The PDF itself is attached. Use it for layout and for anything the manifest could not capture."
      : "Work from the manifest below; the PDF itself is not attached.",
    `This document is classified as "${cls}".`,
    "",
    "RULES",
    '- kind "acroform": nodeId must be an existing af: id. Never invent a field name. For a field with options, the value must be one of them exactly.',
    '- kind "overlay_text": nodeId must be an existing tl: id, and anchorText must be the LABEL text that precedes the blank, copied verbatim from that line and UNIQUE in the entire document. Never use the underscore or dotted run as the anchor — every blank looks identical, so such an anchor is ambiguous and will be discarded.',
    '- kind "overlay_vision": only when the page has no usable text line to anchor to. Supply page and rect in PDF points, origin bottom-left. These are held for human review and are never applied automatically.',
    "- Do not propose read-only fields, buttons, or fields that already hold the correct value.",
    "- Never invent values. A value needs one or more exact evidenceReferences from the supplied keys. Leave value null when nothing supports it — a field with no defensible value is still worth reporting.",
    "- Mark signatures, initials, attestations, consent, bank details, IBANs, certifications and binding commitments as sensitive.",
    "",
    `ACROFORM FIELDS:\n${acroFields.length ? JSON.stringify(acroFields) : "(none)"}`,
    `TEXT LINES:\n${lines.length ? JSON.stringify(lines) : "(none)"}`,
    `STRUCTURED COMPANY PROFILE:\n${input.profileLines.join("\n") || "(none)"}`,
    `RELEVANT DOCUMENT EVIDENCE:\n${input.corpusLines.join("\n") || "(none)"}`,
  ].join("\n");
}
