import { connectMongoose } from "@/lib/db/mongoose";
import { createDownloadUrl, s3Config } from "@/lib/storage/s3";
import { WorkspaceDocument } from "@/models/workspace-document";
import { WorkspaceDocumentVersion } from "@/models/workspace-document-version";

import { normalizeOnlyOfficeDownloadUrl } from "./callback";
import { onlyOfficeEnv } from "./env";
import { fileNameWithExtension, workspaceFormat } from "./formats";
import { signOnlyOfficeConfig } from "./tokens";
import {
  promotePendingObject,
  streamResponseToObject,
  workspacePendingKey,
  workspaceVersionKey,
} from "./storage";

export type ConversionResponse = {
  endConvert?: boolean;
  fileUrl?: string;
  percent?: number;
  error?: number;
};

const ERROR_CODES: Record<number, string> = {
  [-5]: "password_required",
  [-10]: "file_too_large",
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Signed request to the Document Server converter (shared with Dora's
 * spreadsheet→csv text extraction). */
export async function requestConversion(body: Record<string, unknown>, key: string) {
  const env = onlyOfficeEnv();
  const token = await signOnlyOfficeConfig(body);
  const response = await fetch(`${env.internalUrl}/converter?shardkey=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...body, token }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`ONLYOFFICE converter returned HTTP ${response.status}`);
  return (await response.json()) as ConversionResponse;
}

export async function convertWorkspaceDocument(documentId: string): Promise<void> {
  await connectMongoose();
  const document = await WorkspaceDocument.findOne({
    _id: documentId,
    state: { $in: ["converting", "conversion_failed"] },
    deletedAt: null,
  });
  if (!document) return;
  if (document.state === "conversion_failed") {
    document.state = "converting";
    document.stateError = null;
    await document.save();
  }
  const sourceFormat = workspaceFormat(document.fileName);
  if (!sourceFormat?.requiresConversion || !document.currentVersionId) return;
  const sourceVersion = await WorkspaceDocumentVersion.findOne({
    _id: document.currentVersionId,
    documentId: document._id,
    state: "committed",
  }).lean();
  if (!sourceVersion) throw new Error("Conversion source version is missing");

  try {
    const sourceUrl = await createDownloadUrl({
      key: sourceVersion.s3Key,
      fileName: sourceVersion.fileName,
      expiresIn: 60 * 60,
    });
    const conversionKey = `conv-${documentId}-r${document.storageRevision}`;
    const requestBody = {
      async: true,
      filetype: sourceFormat.extension,
      key: conversionKey,
      outputtype: sourceFormat.canonicalExtension,
      title: fileNameWithExtension(document.fileName, sourceFormat.canonicalExtension),
      url: sourceUrl.downloadUrl,
    };
    let outcome: ConversionResponse | null = null;
    for (let attempt = 0; attempt < 180; attempt++) {
      outcome = await requestConversion(requestBody, conversionKey);
      if (outcome.error) {
        throw new Error(ERROR_CODES[outcome.error] || `conversion_error_${outcome.error}`);
      }
      if (outcome.endConvert && outcome.fileUrl) break;
      await delay(2_000);
    }
    if (!outcome?.endConvert || !outcome.fileUrl) throw new Error("conversion_timeout");

    const pendingKey = workspacePendingKey(String(document.companyId), documentId);
    const convertedResponse = await fetch(normalizeOnlyOfficeDownloadUrl(outcome.fileUrl), {
      cache: "no-store",
      redirect: "error",
    });
    const canonicalName = fileNameWithExtension(
      document.fileName,
      sourceFormat.canonicalExtension,
    );
    const canonical = workspaceFormat(canonicalName)!;
    const stored = await streamResponseToObject({
      response: convertedResponse,
      key: pendingKey,
      contentType: canonical.contentType,
    });
    const storageRevision = document.storageRevision + 1;
    const finalKey = workspaceVersionKey({
      companyId: String(document.companyId),
      documentId,
      storageRevision,
      extension: canonical.extension,
    });
    await promotePendingObject({
      pendingKey,
      finalKey,
      contentType: canonical.contentType,
    });
    const version = await WorkspaceDocumentVersion.create({
      companyId: document.companyId,
      documentId: document._id,
      storageRevision,
      editorRevision: document.editorRevision,
      reason: "conversion",
      state: "committed",
      s3Bucket: s3Config().bucket,
      s3Key: finalKey,
      fileName: canonicalName,
      extension: canonical.extension,
      contentType: canonical.contentType,
      size: stored.size,
      sha256: stored.sha256,
      createdBy: "onlyoffice-converter",
    });
    const updated = await WorkspaceDocument.updateOne(
      {
        _id: document._id,
        state: "converting",
        storageRevision: document.storageRevision,
      },
      {
        $set: {
          fileName: canonicalName,
          extension: canonical.extension,
          contentType: canonical.contentType,
          documentType: canonical.documentType,
          currentVersionId: version._id,
          storageRevision,
          state: "ready",
          stateError: null,
          updatedBy: "onlyoffice-converter",
        },
      },
    );
    if (updated.modifiedCount !== 1) {
      await WorkspaceDocumentVersion.updateOne({ _id: version._id }, { state: "orphan" });
      throw new Error("Document changed while conversion was completing");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "conversion_failed";
    await WorkspaceDocument.updateOne(
      { _id: document._id, state: "converting" },
      { $set: { state: "conversion_failed", stateError: message.slice(0, 160) } },
    );
    throw error;
  }
}
