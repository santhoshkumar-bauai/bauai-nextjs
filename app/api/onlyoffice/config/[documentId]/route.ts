import { isValidObjectId } from "mongoose";
import { getLocale } from "next-intl/server";
import { NextResponse } from "next/server";

import { getCompanyContext } from "@/lib/company/context";
import { buildOnlyOfficeConfig } from "@/lib/onlyoffice/config";
import { onlyOfficeEnabled, onlyOfficeEnv } from "@/lib/onlyoffice/env";
import { WorkspaceDocument } from "@/models/workspace-document";

type RouteContext = { params: Promise<{ documentId: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  if (!onlyOfficeEnabled()) {
    return NextResponse.json({ error: "ONLYOFFICE is disabled." }, { status: 503 });
  }
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { documentId } = await params;
  if (!isValidObjectId(documentId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const document = await WorkspaceDocument.findOne({
    _id: documentId,
    companyId: context.company._id,
    deletedAt: null,
  });
  if (!document) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (document.state !== "ready") {
    return NextResponse.json(
      { error: "document_not_ready", state: document.state, detail: document.stateError },
      { status: 409 },
    );
  }
  try {
    const config = await buildOnlyOfficeConfig({
      document,
      context,
      locale: await getLocale(),
    });
    return NextResponse.json(
      { documentServerUrl: onlyOfficeEnv().publicUrl, config },
      { headers: { "cache-control": "private, no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("Failed to create ONLYOFFICE config", error);
    return NextResponse.json({ error: "editor_configuration_failed" }, { status: 503 });
  }
}
