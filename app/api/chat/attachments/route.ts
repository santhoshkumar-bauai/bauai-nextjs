import { NextResponse } from "next/server";

import { storeChatAttachment } from "@/lib/ai/agent/attachments";
import { forCompanyContext } from "@/lib/ai/tenant/repository";
import { getCompanyContext } from "@/lib/company/context";
import { MAX_UPLOAD_BYTES, sanitizeFileName } from "@/lib/storage/s3";

/**
 * Chat attachment upload (multipart). Any file type is accepted: the bytes
 * land in S3, documents get text-extracted, images become model vision input.
 * The returned id is referenced by a later chat POST (attachmentIds); ids
 * never sent expire server-side via TTL.
 */
export async function POST(request: Request) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }
  if (file.size === 0 || file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: "too_large", maxBytes: MAX_UPLOAD_BYTES },
      { status: 413 },
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const attachment = await storeChatAttachment({
    tenantId: forCompanyContext(context).value,
    userId: context.userId,
    fileName: sanitizeFileName(file.name),
    contentType: file.type || "application/octet-stream",
    bytes,
  });

  return NextResponse.json(
    {
      attachment: {
        id: String(attachment._id),
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        size: attachment.size,
        status: attachment.status,
      },
    },
    { status: 201 },
  );
}
