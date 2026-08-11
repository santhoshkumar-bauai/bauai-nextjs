import { isValidObjectId } from "mongoose";
import { NextResponse } from "next/server";

import { getCompanyContext } from "@/lib/company/context";
import { serializeWorkspaceVersion } from "@/lib/onlyoffice/serialize";
import { WorkspaceDocument } from "@/models/workspace-document";
import { WorkspaceDocumentVersion } from "@/models/workspace-document-version";

type RouteContext = { params: Promise<{ documentId: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { documentId } = await params;
  if (!isValidObjectId(documentId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const document = await WorkspaceDocument.findOne({
    _id: documentId,
    companyId: context.company._id,
    deletedAt: null,
  }).lean();
  if (!document) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const versions = await WorkspaceDocumentVersion.find({
    documentId: document._id,
    companyId: context.company._id,
    state: "committed",
  }).sort({ storageRevision: -1 });
  return NextResponse.json({
    items: versions.map((version) => ({
      ...serializeWorkspaceVersion(version),
      restorable: version.extension === document.extension,
    })),
  });
}
