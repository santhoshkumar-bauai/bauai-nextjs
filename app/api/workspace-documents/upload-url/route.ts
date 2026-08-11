import { NextResponse } from "next/server";

import { getCompanyContext } from "@/lib/company/context";
import { onlyOfficeEnabled } from "@/lib/onlyoffice/env";
import { validateWorkspaceFile } from "@/lib/onlyoffice/formats";
import { workspaceIncomingKey } from "@/lib/onlyoffice/storage";
import { signUploadToken } from "@/lib/onlyoffice/tokens";
import { createUploadUrl } from "@/lib/storage/s3";

export async function POST(request: Request) {
  if (!onlyOfficeEnabled()) {
    return NextResponse.json({ error: "ONLYOFFICE is disabled." }, { status: 503 });
  }
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
  const size = typeof body.size === "number" ? body.size : Number.NaN;
  const result = validateWorkspaceFile({ fileName, size });
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  // MIME is derived from the supported extension rather than trusted from the browser.
  const contentType = result.format.contentType;
  const key = workspaceIncomingKey(context.company.id, fileName);
  const [{ uploadUrl, expiresIn }, uploadToken] = await Promise.all([
    createUploadUrl({ key, contentType, contentLength: size, expiresIn: 10 * 60 }),
    signUploadToken({
      companyId: context.company.id,
      userId: context.userId,
      key,
      fileName,
      contentType,
      size,
    }),
  ]);
  return NextResponse.json({
    uploadUrl,
    uploadToken,
    expiresIn,
    method: "PUT",
    headers: { "content-type": contentType },
  });
}
