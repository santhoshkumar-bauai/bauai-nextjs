import { createHash } from "node:crypto";

import { ObjectId } from "mongodb";

import { getAiCollections } from "@/lib/ai/db/collections";
import { connectMongoose } from "@/lib/db/mongoose";
import { fillDocxBuffer, type DocxFillInstruction } from "@/lib/onlyoffice/docx-fill";
import {
  fillPdfBuffer,
  narrowPdfInstructions,
  verifyFilledPdf,
  type PdfFillCandidate,
} from "@/lib/onlyoffice/pdf-fill";
import { createWorkspaceDocumentFromObject } from "@/lib/onlyoffice/document-service";
import { onlyOfficeEnv } from "@/lib/onlyoffice/env";
import { workspaceFormat } from "@/lib/onlyoffice/formats";
import { normalizeOnlyOfficeDownloadUrl } from "@/lib/onlyoffice/callback";
import { streamResponseToObject, workspacePendingKey } from "@/lib/onlyoffice/storage";
import { signOnlyOfficeConfig } from "@/lib/onlyoffice/tokens";
import { createDownloadUrl, getObjectBuffer, putObjectBuffer } from "@/lib/storage/s3";
import { WorkspaceDocument } from "@/models/workspace-document";
import { WorkspaceDocumentVersion } from "@/models/workspace-document-version";

import { fillRunFormat } from "./format";
import { canAutoApply } from "./locators";
import { updateFillRun } from "./runs";
import type { DocumentFillLocator } from "./types";

type BuilderResponse = {
  end?: boolean;
  error?: number;
  urls?: Record<string, string>;
  url?: string;
};

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mirror of narrowPdfInstructions for the Word engine. Fill fields are rebuilt
 * from Mongo, so the locator union is only as narrow as the stored data.
 */
function narrowDocxInstructions(
  fields: Array<{ id: string; value: string } & DocumentFillLocator>,
): DocxFillInstruction[] {
  return fields.map((field) => {
    if (field.strategy !== "form_key" && field.strategy !== "unique_text") {
      throw new Error(`pdf_locator_in_docx:${field.id}`);
    }
    return field;
  });
}

async function pageCountOf(bytes: Buffer): Promise<number> {
  const { PDFDocument } = await import("pdf-lib");
  return (await PDFDocument.load(Uint8Array.from(bytes), { updateMetadata: false })).getPageCount();
}

async function requestBuilder(body: Record<string, unknown>, key: string) {
  const token = await signOnlyOfficeConfig(body);
  const response = await fetch(
    `${onlyOfficeEnv().internalUrl}/docbuilder?shardkey=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...body, token }),
      cache: "no-store",
    },
  );
  if (!response.ok) throw new Error(`docbuilder_http_${response.status}`);
  return (await response.json()) as BuilderResponse;
}

export async function generateDocumentFillCopy(runIdHex: string): Promise<void> {
  const runId = new ObjectId(runIdHex);
  const { documentFillRuns } = await getAiCollections();
  const run = await documentFillRuns.findOne({ _id: runId });
  if (!run || !["review", "generating"].includes(run.status)) return;
  // Format dispatch mirrors analyze.ts; the GAEB writer patches XML in
  // process and never touches the Document Builder.
  if (fillRunFormat(run) === "gaeb") {
    const { generateGaebFillCopy } = await import("./gaeb/generate-gaeb");
    return generateGaebFillCopy(runIdHex);
  }
  await updateFillRun(runId, { status: "generating", stage: "building", error: null });

  try {
    await connectMongoose();
    const [source, version] = await Promise.all([
      WorkspaceDocument.findOne({ _id: run.documentId, companyId: run.tenantId, deletedAt: null }).lean(),
      WorkspaceDocumentVersion.findOne({
        _id: run.sourceVersionId,
        documentId: run.documentId,
        sha256: run.sourceSha256,
        state: "committed",
      }).lean(),
    ]);
    if (!source || !version) throw new Error("source_version_missing");
    const runFormat = fillRunFormat(run);
    if (runFormat === "docx" && (source.documentType !== "word" || source.extension !== "docx")) {
      throw new Error("word_docx_required");
    }
    if (runFormat === "pdf" && (source.documentType !== "pdf" || source.extension !== "pdf")) {
      throw new Error("pdf_required");
    }
    // Re-filtered server-side, ignoring whatever the client selected.
    // canAutoApply additionally drops targets whose POSITION nothing verified.
    const fields = run.fields.flatMap((field) => {
      if (
        field.state !== "ready" ||
        !field.value ||
        !field.locator ||
        field.sensitive ||
        !canAutoApply(field.locator)
      ) {
        return [];
      }
      return [{ id: field.id, value: field.value, ...field.locator }];
    });
    if (fields.length === 0) throw new Error("no_ready_fields");

    await updateFillRun(runId, { stage: "storing" });
    const extension = runFormat === "pdf" ? "pdf" : "docx";
    const stem = source.fileName.replace(new RegExp(`\\.${extension}$`, "i"), "");
    const fileName = `${stem} - filled.${extension}`;
    const format = workspaceFormat(fileName);
    if (!format) throw new Error("generated_format_invalid");
    const pendingKey = workspacePendingKey(run.tenantId.toHexString(), run.documentId.toHexString());
    let stored: { sha256: string; size: number };
    if (runFormat === "pdf") {
      // Always in-process. The Document Builder script is docx-only, and PDF
      // filling needs no Document Server round trip at all.
      const sourceBytes = await getObjectBuffer(version.s3Key);
      const instructions = narrowPdfInstructions(fields as PdfFillCandidate[]);
      const outputBytes = await fillPdfBuffer(sourceBytes, instructions, {
        expectedManifestHash: run.pdf?.manifestHash,
      });
      // Verified BEFORE anything is stored, so a bad write never leaves an
      // orphaned S3 object behind. PDF writes fail quietly: a value can be set
      // on a field that renders blank, and an overlay can land far from its
      // target without erroring.
      const verdict = await verifyFilledPdf(
        outputBytes,
        instructions,
        run.pdf?.pageCount ?? (await pageCountOf(sourceBytes)),
      );
      if (!verdict.ok) {
        throw new Error(
          `pdf_verification_failed:${verdict.failures.map((f) => f.id).join(",")}`.slice(0, 200),
        );
      }
      await putObjectBuffer(pendingKey, outputBytes, format.contentType);
      stored = {
        size: outputBytes.byteLength,
        sha256: createHash("sha256").update(outputBytes).digest("hex"),
      };
    } else if (process.env.ONLYOFFICE_DOCUMENT_BUILDER_ENABLED === "true") {
      const sourceUrl = await createDownloadUrl({
        key: version.s3Key,
        fileName: version.fileName,
        expiresIn: 60 * 60,
      });
      const key = `fill-${runIdHex}-${run.sourceStorageRevision}`;
      const body = {
        async: true,
        key,
        url: `${onlyOfficeEnv().callbackBaseUrl}/onlyoffice/document-fill.docbuilder`,
        argument: { sourceUrl: sourceUrl.downloadUrl, fields },
      };
      let outcome: BuilderResponse | null = null;
      for (let attempt = 0; attempt < 180; attempt++) {
        outcome = await requestBuilder(body, key);
        if (outcome.error) throw new Error(`docbuilder_error_${outcome.error}`);
        if (outcome.end) break;
        await delay(2_000);
      }
      const outputUrl = outcome?.urls?.["filled.docx"] ?? outcome?.url ?? null;
      if (!outcome?.end || !outputUrl) throw new Error("docbuilder_timeout");
      const response = await fetch(normalizeOnlyOfficeDownloadUrl(outputUrl), {
        cache: "no-store",
        redirect: "error",
      });
      stored = await streamResponseToObject({
        response,
        key: pendingKey,
        contentType: format.contentType,
      });
    } else {
      const sourceBytes = await getObjectBuffer(version.s3Key);
      const outputBytes = await fillDocxBuffer(sourceBytes, narrowDocxInstructions(fields));
      await putObjectBuffer(pendingKey, outputBytes, format.contentType);
      stored = {
        size: outputBytes.byteLength,
        sha256: createHash("sha256").update(outputBytes).digest("hex"),
      };
    }
    const generated = await createWorkspaceDocumentFromObject({
      companyId: source.companyId,
      tenderId: source.tenderId ?? null,
      source: {
        kind: "generated-fill",
        sourceDocumentId: source._id,
        fillRunId: run._id,
      },
      fileName,
      format,
      contentType: format.contentType,
      size: stored.size,
      sha256: stored.sha256,
      sourceKey: pendingKey,
      actorId: run.startedByUserId,
      versionReason: "generated_fill",
    });
    await updateFillRun(runId, {
      status: "completed",
      stage: "done",
      generatedDocumentId: new ObjectId(String(generated._id)),
      finishedAt: new Date(),
    });
  } catch (error) {
    await updateFillRun(runId, {
      status: "failed",
      error: (error instanceof Error ? error.message : "generation_failed").slice(0, 500),
      finishedAt: new Date(),
    });
    throw error;
  }
}
