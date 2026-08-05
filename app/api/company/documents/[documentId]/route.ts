import { NextResponse } from "next/server";

import { getCompanyContext } from "@/lib/company/context";
import { serializeCompanyFile } from "@/lib/company/serialize";
import { createDownloadUrl, deleteObject } from "@/lib/storage/s3";
import { CompanyFile } from "@/models/company-file";
import { isValidObjectId } from "mongoose";

type RouteParams = { params: Promise<{ documentId: string }> };

/** Returns a short-lived presigned URL for viewing/downloading the file. */
export async function GET(_request: Request, { params }: RouteParams) {
  const context = await getCompanyContext();
  if (!context)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { documentId } = await params;
  if (!isValidObjectId(documentId)) {
    return NextResponse.json({ error: "Invalid document id." }, { status: 400 });
  }

  const file = await CompanyFile.findOne({
    _id: documentId,
    companyId: context.company._id,
  });
  if (!file) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  try {
    const { downloadUrl, expiresIn } = await createDownloadUrl({
      key: file.s3Key,
      fileName: file.fileName,
    });
    return NextResponse.json({
      file: serializeCompanyFile(file),
      downloadUrl,
      expiresIn,
    });
  } catch (error) {
    console.error("Failed to create download URL", error);
    return NextResponse.json(
      { error: "Storage is unavailable." },
      { status: 503 },
    );
  }
}

/** Deletes the file: the S3 object first, then the metadata row. */
export async function DELETE(_request: Request, { params }: RouteParams) {
  const context = await getCompanyContext();
  if (!context)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { documentId } = await params;
  if (!isValidObjectId(documentId)) {
    return NextResponse.json({ error: "Invalid document id." }, { status: 400 });
  }

  const file = await CompanyFile.findOne({
    _id: documentId,
    companyId: context.company._id,
  });
  if (!file) {
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  try {
    await deleteObject(file.s3Key);
  } catch (error) {
    // Removing the bucket object is what actually frees storage; if it fails the
    // metadata row is kept so the file stays visible and the delete is retryable.
    console.error("Failed to delete object from storage", error);
    return NextResponse.json(
      { error: "Failed to delete the file from storage. Try again." },
      { status: 502 },
    );
  }

  await file.deleteOne();
  return NextResponse.json({ ok: true, id: documentId });
}
