import { createHash } from "node:crypto";

import { ObjectId } from "mongodb";

import { getAiCollections } from "@/lib/ai/db/collections";
import { connectMongoose } from "@/lib/db/mongoose";
import { fillDocxBuffer } from "@/lib/onlyoffice/docx-fill";
import { createWorkspaceDocumentFromObject } from "@/lib/onlyoffice/document-service";
import { onlyOfficeEnv } from "@/lib/onlyoffice/env";
import { workspaceFormat } from "@/lib/onlyoffice/formats";
import { normalizeOnlyOfficeDownloadUrl } from "@/lib/onlyoffice/callback";
import { streamResponseToObject, workspacePendingKey } from "@/lib/onlyoffice/storage";
import { signOnlyOfficeConfig } from "@/lib/onlyoffice/tokens";
import { createDownloadUrl, getObjectBuffer, putObjectBuffer } from "@/lib/storage/s3";
import { WorkspaceDocument } from "@/models/workspace-document";
import { WorkspaceDocumentVersion } from "@/models/workspace-document-version";

import { updateFillRun } from "./runs";

type BuilderResponse = {
  end?: boolean;
  error?: number;
  urls?: Record<string, string>;
  url?: string;
};

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    if (source.documentType !== "word" || source.extension !== "docx") {
      throw new Error("word_docx_required");
    }
    const fields = run.fields.flatMap((field) => {
      if (
        field.state !== "ready" ||
        !field.value ||
        !field.locator ||
        field.sensitive
      ) {
        return [];
      }
      return [{ id: field.id, value: field.value, ...field.locator }];
    });
    if (fields.length === 0) throw new Error("no_ready_fields");

    await updateFillRun(runId, { stage: "storing" });
    const fileName = `${source.fileName.replace(/\.docx$/i, "")} - filled.docx`;
    const format = workspaceFormat(fileName);
    if (!format) throw new Error("generated_format_invalid");
    const pendingKey = workspacePendingKey(run.tenantId.toHexString(), run.documentId.toHexString());
    let stored: { sha256: string; size: number };
    if (process.env.ONLYOFFICE_DOCUMENT_BUILDER_ENABLED === "true") {
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
      const outputBytes = await fillDocxBuffer(sourceBytes, fields);
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
