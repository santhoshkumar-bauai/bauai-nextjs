import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";

import { getCompanyContext } from "@/lib/company/context";
import { mongoDatabase } from "@/lib/db/mongodb";
import type { TenderDocument } from "@/lib/ingestion/types";
import { createWorkspaceDocumentFromObject } from "@/lib/onlyoffice/document-service";
import { onlyOfficeEnabled } from "@/lib/onlyoffice/env";
import { validateWorkspaceFile } from "@/lib/onlyoffice/formats";
import { serializeWorkspaceDocument } from "@/lib/onlyoffice/serialize";
import { findTenderFile } from "@/lib/tenders/document-files";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  if (!onlyOfficeEnabled()) {
    return NextResponse.json({ error: "ONLYOFFICE is disabled." }, { status: 503 });
  }
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  if (!ObjectId.isValid(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as {
    recordId?: unknown;
    fileIndex?: unknown;
  } | null;
  const recordId = typeof body?.recordId === "string" ? body.recordId : "";
  const fileIndex = typeof body?.fileIndex === "number" ? body.fileIndex : -1;
  if (!recordId || !Number.isInteger(fileIndex) || fileIndex < 0) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const tenderId = new ObjectId(id);
  const tender = await mongoDatabase
    .collection<TenderDocument>("tenders")
    .findOne({ _id: tenderId }, { projection: { isVisible: 1 } });
  if (!tender || tender.isVisible === false) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const file = await findTenderFile(tenderId, recordId, fileIndex);
  if (!file) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const validation = validateWorkspaceFile({ fileName: file.fileName, size: file.byteLength });
  if ("error" in validation) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  try {
    const document = await createWorkspaceDocumentFromObject({
      companyId: context.company._id,
      tenderId,
      source: { kind: "tender-copy", tenderRecordId: recordId, tenderFileIndex: fileIndex },
      fileName: file.fileName,
      format: validation.format,
      contentType: validation.format.contentType,
      size: file.byteLength,
      sha256: file.sha256,
      sourceBucket: file.s3.bucket,
      sourceKey: file.s3.key,
      actorId: context.userId,
    });
    if (validation.format.requiresConversion) {
      try {
        const { enqueueOnlyOfficeConversion } = await import("@/lib/onlyoffice/queue");
        await enqueueOnlyOfficeConversion(String(document._id));
      } catch (error) {
        console.error("Failed to enqueue ONLYOFFICE conversion", error);
        document.state = "conversion_failed";
        document.stateError = "conversion_queue_unavailable";
        await document.save();
      }
    }
    return NextResponse.json(
      { document: serializeWorkspaceDocument(document) },
      { status: 201 },
    );
  } catch (error) {
    console.error("Failed to create tender working copy", error);
    return NextResponse.json({ error: "working_copy_failed" }, { status: 502 });
  }
}
