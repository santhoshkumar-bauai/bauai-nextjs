import type { CompanyFileCategory } from "@/models/company-file";
import type { SerializedCompanyFile } from "@/lib/company/serialize";

/**
 * Browser helper for the presigned upload flow. Keeps the three round-trips
 * (mint URL → PUT to S3 → confirm) in one place so components don't re-implement
 * it. Safe to import in client components — it touches only `fetch`.
 */

type UploadUrlResponse = {
  key: string;
  uploadUrl: string;
  contentType: string;
  category: CompanyFileCategory;
};

async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string };
    return data.error || `Request failed (${response.status}).`;
  } catch {
    return `Request failed (${response.status}).`;
  }
}

export type UploadResult =
  | { category: "logo"; logoUrl: string }
  | { category: Exclude<CompanyFileCategory, "logo">; file: SerializedCompanyFile };

/**
 * Uploads a single file to the company's storage and returns the confirmed
 * result. Throws with a human-readable message on any step failure.
 */
export async function uploadCompanyFile(
  file: File,
  category: CompanyFileCategory,
  options: { signal?: AbortSignal } = {},
): Promise<UploadResult> {
  // 1. Ask the API for a presigned PUT URL scoped to this object.
  const urlResponse = await fetch("/api/company/documents/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type || "application/octet-stream",
      size: file.size,
      category,
    }),
    signal: options.signal,
  });
  if (!urlResponse.ok) throw new Error(await readError(urlResponse));
  const { key, uploadUrl, contentType } =
    (await urlResponse.json()) as UploadUrlResponse;

  // 2. Stream the bytes straight to the bucket. The Content-Type must match the
  //    one the URL was signed for or S3 rejects the PUT.
  const putResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: file,
    signal: options.signal,
  });
  if (!putResponse.ok) {
    throw new Error(`Upload to storage failed (${putResponse.status}).`);
  }

  // 3. Confirm — the API verifies the object landed and persists its metadata.
  const confirmResponse = await fetch("/api/company/documents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, fileName: file.name, contentType, category }),
    signal: options.signal,
  });
  if (!confirmResponse.ok) throw new Error(await readError(confirmResponse));

  const data = (await confirmResponse.json()) as {
    logoUrl?: string;
    file?: SerializedCompanyFile;
  };
  if (category === "logo") {
    return { category: "logo", logoUrl: data.logoUrl ?? "" };
  }
  return {
    category: category as Exclude<CompanyFileCategory, "logo">,
    file: data.file as SerializedCompanyFile,
  };
}

/** Requests a fresh presigned view URL for an existing document. */
export async function getCompanyFileUrl(documentId: string): Promise<string> {
  const response = await fetch(`/api/company/documents/${documentId}`);
  if (!response.ok) throw new Error(await readError(response));
  const data = (await response.json()) as { downloadUrl: string };
  return data.downloadUrl;
}

/** Deletes an uploaded document (removes the S3 object and its metadata). */
export async function deleteCompanyFile(documentId: string): Promise<void> {
  const response = await fetch(`/api/company/documents/${documentId}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error(await readError(response));
}
