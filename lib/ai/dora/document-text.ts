import type { ObjectId } from "mongodb";

import { normalizeOnlyOfficeDownloadUrl } from "../../onlyoffice/callback.ts";
import { onlyOfficeEnabled } from "../../onlyoffice/env.ts";
import { requestConversion } from "../../onlyoffice/conversion.ts";
import { extractText } from "../../ingestion/documents/text-extract.ts";
import { logger } from "../../ingestion/observability/logger.ts";
import { createDownloadUrl, getObjectBuffer } from "../../storage/s3.ts";
import { getAiCollections } from "../db/collections.ts";
import type { WorkspaceDocumentTextDocument } from "../types.ts";
import type { DoraDocumentScope } from "./context.ts";

const log = logger.child("ai.dora.text");

/**
 * Extracted text of the CURRENT committed workspace-document version, cached
 * in `workspace_document_texts` keyed by content hash — workspace docs have no
 * ingestion pipeline, so this module IS their text extraction. PDFs/DOCX go
 * through the ingestion extractor (unpdf/mammoth); spreadsheets take a
 * Document Server →csv hop (first sheet only, declared); scanned PDFs come
 * back "unsupported" with a `no_text_layer` note (no OCR exists anywhere).
 */

export const WORKSPACE_TEXT_MAX_CHARS = 200_000;
/** Latest rows kept per document — enough for quick version flips/restores. */
const KEEP_ROWS_PER_DOCUMENT = 3;

export interface WorkspaceDocText {
  status: "ready" | "unsupported" | "failed";
  source: "native" | "converted-csv" | "gaeb-projection" | null;
  note: string | null;
  text: string;
  /** Full pre-cap length; `truncated` when it exceeded the stored cap. */
  chars: number;
  truncated: boolean;
}

export function workspaceTextCacheKey(documentId: string, sha256: string): string {
  return `wdoc:${documentId}:${sha256}`;
}

function project(doc: WorkspaceDocumentTextDocument): WorkspaceDocText {
  return {
    status: doc.status,
    source: doc.source,
    note: doc.note,
    text: doc.text,
    chars: doc.chars,
    truncated: doc.truncated,
  };
}

export async function getWorkspaceDocumentText(
  scope: DoraDocumentScope,
  tenantId: ObjectId,
): Promise<WorkspaceDocText> {
  const version = scope.version;
  if (!version) {
    return {
      status: "failed",
      source: null,
      note: "no_committed_version",
      text: "",
      chars: 0,
      truncated: false,
    };
  }

  const { workspaceDocumentTexts } = await getAiCollections();
  const key = workspaceTextCacheKey(scope.documentId.toHexString(), version.sha256);
  const cached = await workspaceDocumentTexts.findOne({ _id: key, tenantId });
  if (cached) return project(cached);

  let status: WorkspaceDocText["status"];
  let source: WorkspaceDocText["source"] = null;
  let note: string | null = null;
  let fullText = "";

  const persistWorkspaceText = async (): Promise<WorkspaceDocText> => {
    const truncated = fullText.length > WORKSPACE_TEXT_MAX_CHARS;
    const doc: WorkspaceDocumentTextDocument = {
      _id: key,
      tenantId,
      documentId: scope.documentId,
      versionId: version.id,
      sha256: version.sha256,
      status,
      source,
      note,
      text: truncated ? fullText.slice(0, WORKSPACE_TEXT_MAX_CHARS) : fullText,
      chars: fullText.length,
      truncated,
      extractedAt: new Date(),
    };
    await workspaceDocumentTexts.updateOne({ _id: key }, { $set: doc }, { upsert: true });

    // Prune superseded versions' rows, newest-first survivors.
    const stale = await workspaceDocumentTexts
      .find({ documentId: scope.documentId }, { projection: { _id: 1 } })
      .sort({ extractedAt: -1 })
      .skip(KEEP_ROWS_PER_DOCUMENT)
      .toArray();
    if (stale.length > 0) {
      await workspaceDocumentTexts.deleteMany({
        _id: { $in: stale.map((row) => row._id) },
      });
    }

    return project(doc);
  };

  try {
    // GAEB is structured position data; its "text" is the parser's
    // projection (category tree + positions), not raw XML markup. Falls
    // through to the shared cache/prune block below like every other format.
    if (scope.documentType === "gaeb") {
      const { getOrParseGaebDocument } = await import("../../gaeb/store.ts");
      const { projectGaebToText } = await import("../../gaeb/text-projection.ts");
      const stored = await getOrParseGaebDocument({
        tenantId,
        documentId: scope.documentId,
        versionId: version.id,
        sourceSha256: version.sha256,
        s3Key: version.s3Key,
        extension: version.extension,
      });
      if (stored.document) {
        status = "ready";
        source = "gaeb-projection";
        fullText = projectGaebToText(stored.document);
      } else {
        status = "unsupported";
        note = `gaeb_parse_failed:${stored.parseError?.code ?? "unknown"}`.slice(0, 120);
      }
      return persistWorkspaceText();
    }

    const buffer = await getObjectBuffer(version.s3Key);
    const extracted = await extractText(buffer, version.contentType, version.fileName);

    if (extracted.status === "DONE") {
      status = "ready";
      source = "native";
      fullText = extracted.text;
    } else if (extracted.status === "UNSUPPORTED" && scope.documentType === "cell") {
      const csv = await convertVersionToCsv(scope).catch((error) => {
        log.warn("spreadsheet csv conversion failed", {
          documentId: scope.documentId.toHexString(),
          error: String(error).slice(0, 200),
        });
        return null;
      });
      if (csv && csv.trim()) {
        status = "ready";
        source = "converted-csv";
        note = "first_sheet_only";
        fullText = csv;
      } else {
        status = "unsupported";
        note = "spreadsheet_unsupported";
      }
    } else if (extracted.status === "UNSUPPORTED") {
      status = "unsupported";
      note = extracted.error === "no text layer" ? "no_text_layer" : "unsupported_format";
    } else {
      status = "failed";
      note = extracted.error?.slice(0, 120) ?? "extraction_failed";
    }
  } catch (error) {
    log.warn("workspace document text extraction failed", {
      documentId: scope.documentId.toHexString(),
      error: String(error).slice(0, 200),
    });
    status = "failed";
    note = "extraction_failed";
  }

  return persistWorkspaceText();
}

/**
 * Spreadsheet text via the Document Server converter: current version's
 * presigned URL in, csv out. ONLYOFFICE csv export covers only the first
 * sheet — callers surface `first_sheet_only`, never silently present a
 * partial workbook as complete.
 */
async function convertVersionToCsv(scope: DoraDocumentScope): Promise<string | null> {
  if (!onlyOfficeEnabled() || !scope.version) return null;
  const download = await createDownloadUrl({
    key: scope.version.s3Key,
    fileName: scope.version.fileName,
    expiresIn: 60 * 60,
  });
  const conversionKey = `dora-csv-${scope.documentId.toHexString()}-r${scope.version.storageRevision}`;
  const outcome = await requestConversion(
    {
      async: false,
      filetype: scope.version.extension,
      key: conversionKey,
      outputtype: "csv",
      title: "export.csv",
      url: download.downloadUrl,
    },
    conversionKey,
  );
  if (outcome.error || !outcome.endConvert || !outcome.fileUrl) return null;
  const response = await fetch(normalizeOnlyOfficeDownloadUrl(outcome.fileUrl), {
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) return null;
  return await response.text();
}
