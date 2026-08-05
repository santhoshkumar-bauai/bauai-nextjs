import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { getCompanyContext } from "@/lib/company/context";
import {
  ALLOWED_DOCUMENT_CONTENT_TYPES,
  ALLOWED_LOGO_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  buildObjectKey,
  createUploadUrl,
} from "@/lib/storage/s3";
import {
  COMPANY_FILE_CATEGORIES,
  type CompanyFileCategory,
} from "@/models/company-file";

type UploadUrlBody = {
  fileName?: unknown;
  contentType?: unknown;
  category?: unknown;
  size?: unknown;
};

/**
 * Step 1 of the presigned-upload flow. Validates the request and returns a
 * short-lived PUT URL the browser uploads directly to, plus the object key it
 * must echo back to the confirm endpoint. No database row is written here, so an
 * abandoned upload leaves only an orphan S3 object (swept out of band), never a
 * dangling record.
 */
export async function POST(request: Request) {
  const context = await getCompanyContext();
  if (!context)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: UploadUrlBody;
  try {
    body = (await request.json()) as UploadUrlBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
  const contentType =
    typeof body.contentType === "string" ? body.contentType.trim() : "";
  const category = body.category as CompanyFileCategory;
  const size = typeof body.size === "number" ? body.size : Number(body.size);

  if (!fileName) {
    return NextResponse.json(
      { error: "A file name is required." },
      { status: 400 },
    );
  }
  if (!COMPANY_FILE_CATEGORIES.includes(category)) {
    return NextResponse.json(
      {
        error: `Invalid category. Expected one of: ${COMPANY_FILE_CATEGORIES.join(", ")}.`,
      },
      { status: 400 },
    );
  }

  const allowed =
    category === "logo"
      ? (ALLOWED_LOGO_CONTENT_TYPES as readonly string[])
      : (ALLOWED_DOCUMENT_CONTENT_TYPES as readonly string[]);
  if (!contentType || !allowed.includes(contentType)) {
    return NextResponse.json(
      { error: `Unsupported content type "${contentType}" for ${category}.` },
      { status: 400 },
    );
  }

  if (!Number.isFinite(size) || size <= 0) {
    return NextResponse.json(
      { error: "A positive file size is required." },
      { status: 400 },
    );
  }
  if (size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error: `File exceeds the ${Math.floor(
          MAX_UPLOAD_BYTES / (1024 * 1024),
        )} MB upload limit.`,
      },
      { status: 413 },
    );
  }

  const key = buildObjectKey({
    companyId: context.company.id,
    category,
    fileName,
    uniqueId: randomUUID(),
  });

  try {
    const { uploadUrl, expiresIn } = await createUploadUrl({
      key,
      contentType,
      contentLength: size,
    });
    return NextResponse.json({
      key,
      uploadUrl,
      expiresIn,
      contentType,
      category,
      method: "PUT",
    });
  } catch (error) {
    console.error("Failed to create upload URL", error);
    return NextResponse.json(
      { error: "Storage is not configured or unavailable." },
      { status: 503 },
    );
  }
}
