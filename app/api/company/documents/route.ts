import { NextResponse } from "next/server";

import { getCompanyContext } from "@/lib/company/context";
import { serializeCompanyFile } from "@/lib/company/serialize";
import {
  createDownloadUrl,
  deleteObject,
  headObject,
  objectKeyPrefix,
  s3Config,
} from "@/lib/storage/s3";
import {
  COMPANY_FILE_CATEGORIES,
  CompanyFile,
  type CompanyFileCategory,
} from "@/models/company-file";

type ConfirmBody = {
  key?: unknown;
  fileName?: unknown;
  contentType?: unknown;
  category?: unknown;
};

/**
 * Lists the company's uploaded files. Optionally filtered by `?category=`. Logo
 * files are not part of this collection — the logo lives on the company profile.
 */
export async function GET(request: Request) {
  const context = await getCompanyContext();
  if (!context)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const categoryParam = new URL(request.url).searchParams.get("category");
  const filter: Record<string, unknown> = { companyId: context.company._id };
  if (categoryParam) {
    if (!COMPANY_FILE_CATEGORIES.includes(categoryParam as CompanyFileCategory)) {
      return NextResponse.json(
        { error: "Invalid category filter." },
        { status: 400 },
      );
    }
    filter.category = categoryParam;
  }

  const files = await CompanyFile.find(filter).sort({ createdAt: -1 });
  return NextResponse.json({ items: files.map(serializeCompanyFile) });
}

/**
 * Step 2 of the presigned-upload flow. Confirms an object the browser uploaded:
 * verifies the key belongs to this company, checks the object actually landed in
 * the bucket (HeadObject), then persists its metadata. A `logo` upload is stored
 * on the company profile and replaces any previous logo; everything else becomes
 * a CompanyFile row.
 */
export async function POST(request: Request) {
  const context = await getCompanyContext();
  if (!context)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: ConfirmBody;
  try {
    body = (await request.json()) as ConfirmBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const key = typeof body.key === "string" ? body.key : "";
  const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
  const contentType =
    typeof body.contentType === "string" ? body.contentType.trim() : "";
  const category = body.category as CompanyFileCategory;

  if (!key || !fileName) {
    return NextResponse.json(
      { error: "Both key and fileName are required." },
      { status: 400 },
    );
  }
  if (!COMPANY_FILE_CATEGORIES.includes(category)) {
    return NextResponse.json({ error: "Invalid category." }, { status: 400 });
  }
  // The key was minted by the upload-url endpoint for THIS company + category.
  // Rejecting a foreign prefix stops a caller from attaching someone else's
  // object (or a tender-ingestion object) to their company.
  if (!key.startsWith(objectKeyPrefix(context.company.id, category))) {
    return NextResponse.json(
      { error: "Upload key does not belong to this company." },
      { status: 403 },
    );
  }

  let head: Awaited<ReturnType<typeof headObject>>;
  try {
    head = await headObject(key);
  } catch (error) {
    console.error("Failed to verify uploaded object", error);
    return NextResponse.json(
      { error: "Storage is unavailable." },
      { status: 503 },
    );
  }
  if (!head) {
    return NextResponse.json(
      { error: "Uploaded object was not found. Re-upload and try again." },
      { status: 409 },
    );
  }

  if (category === "logo") {
    const previousKey = context.company.logoKey;
    context.company.set({ logoKey: key });
    await context.company.save();
    // Best-effort cleanup of the replaced logo — a failure here only leaves an
    // orphan object, it must not fail the request.
    if (previousKey && previousKey !== key) {
      await deleteObject(previousKey).catch((error) =>
        console.error("Failed to delete previous logo object", error),
      );
    }
    const { downloadUrl } = await createDownloadUrl({ key, fileName });
    return NextResponse.json({ logoUrl: downloadUrl }, { status: 201 });
  }

  const file = await CompanyFile.create({
    companyId: context.company._id,
    category,
    fileName,
    contentType: contentType || head.contentType || "application/octet-stream",
    size: head.contentLength,
    s3Bucket: s3Config().bucket,
    s3Key: key,
    uploadedBy: context.userId,
  });

  return NextResponse.json(
    { file: serializeCompanyFile(file) },
    { status: 201 },
  );
}
