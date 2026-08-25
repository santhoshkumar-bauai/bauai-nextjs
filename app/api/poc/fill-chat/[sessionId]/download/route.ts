import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";

import { getFillSession } from "@/lib/ai/fill-agent/store";
import { forCompanyContext } from "@/lib/ai/tenant/repository";
import { getCompanyContext } from "@/lib/company/context";
import { createDownloadUrl } from "@/lib/storage/s3";

/** Redirects to a short-lived presigned URL for the accepted filled PDF. */

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { sessionId } = await params;
  if (!ObjectId.isValid(sessionId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const tenantId = forCompanyContext(context).value;
  const session = await getFillSession(tenantId, new ObjectId(sessionId));
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!session.output) {
    return NextResponse.json({ error: "not_ready" }, { status: 409 });
  }

  const { downloadUrl } = await createDownloadUrl({
    key: session.output.s3Key,
    fileName: `filled-${session.source.fileName}`,
    disposition: "attachment",
  });
  return NextResponse.redirect(downloadUrl, 307);
}
