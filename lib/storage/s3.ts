import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * S3-compatible object storage for user-uploaded company files (logos and
 * knowledge-base documents).
 *
 * Uploads use the presigned-URL pattern: the browser never receives the bucket
 * credentials. The API mints a short-lived PUT URL scoped to a single object
 * key (and its content type), the browser streams the bytes straight to the
 * bucket, and a follow-up "confirm" call verifies the object landed before any
 * metadata is written to MongoDB. Reads are served the same way with a
 * short-lived GET URL, so private objects never need a public bucket policy.
 *
 * The bucket credentials are shared with the tender ingestion pipeline
 * (`lib/ingestion/storage`); company uploads are namespaced under their own
 * prefix so the two never collide.
 */

const UPLOAD_URL_TTL_SECONDS = 5 * 60;
const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

/** Max size the API will mint an upload URL for (25 MB). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Content types accepted for knowledge-base document uploads. */
export const ALLOWED_DOCUMENT_CONTENT_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

/** Content types accepted for company logo uploads. */
export const ALLOWED_LOGO_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
] as const;

export type S3Config = {
  bucket: string;
  endpoint: string;
  region: string;
  keyId: string;
  applicationKey: string;
  prefix: string;
};

function readS3Config(): S3Config {
  return {
    bucket: process.env.S3_BUCKET_NAME ?? "",
    endpoint: process.env.S3_ENDPOINT ?? "",
    region: process.env.S3_REGION || "us-east-1",
    keyId: process.env.S3_KEY_ID ?? "",
    applicationKey: process.env.S3_APPLICATION_KEY ?? "",
    prefix: process.env.S3_COMPANY_PREFIX || "companies",
  };
}

let cachedClient: S3Client | null = null;
let cachedConfig: S3Config | null = null;

export function assertS3Configured(config = readS3Config()): asserts config is S3Config {
  const missing = (["bucket", "keyId", "applicationKey"] as const).filter(
    (key) => !config[key],
  );
  if (missing.length > 0) {
    throw new Error(
      `S3 storage is not configured. Missing env: ${missing
        .map((key) =>
          key === "bucket"
            ? "S3_BUCKET_NAME"
            : key === "keyId"
              ? "S3_KEY_ID"
              : "S3_APPLICATION_KEY",
        )
        .join(", ")}.`,
    );
  }
}

export function s3Config(): S3Config {
  cachedConfig ??= readS3Config();
  return cachedConfig;
}

function s3(): S3Client {
  if (cachedClient) return cachedClient;
  const config = s3Config();
  assertS3Configured(config);
  cachedClient = new S3Client({
    region: config.region,
    // An empty endpoint lets the SDK target AWS S3 directly; any other
    // S3-compatible provider (R2, B2, MinIO) sets S3_ENDPOINT explicitly.
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    credentials: {
      accessKeyId: config.keyId,
      secretAccessKey: config.applicationKey,
    },
    // R2, B2, and MinIO all address objects as `<endpoint>/<bucket>/<key>`.
    forcePathStyle: Boolean(config.endpoint),
  });
  return cachedClient;
}

/** Strips path separators and unsafe characters from a client-supplied name. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return cleaned || "file";
}

/**
 * Builds a collision-resistant object key namespaced by company and category.
 * The random suffix means two uploads of the same file name never overwrite
 * each other, and the company id in the path scopes deletes and audits.
 */
export function buildObjectKey(params: {
  companyId: string;
  category: string;
  fileName: string;
  uniqueId: string;
}): string {
  const { companyId, category, fileName, uniqueId } = params;
  const safeCompany = companyId.replace(/[^A-Za-z0-9]/g, "");
  const safeCategory = category.replace(/[^a-z0-9-]/g, "");
  return [
    s3Config().prefix,
    safeCompany,
    safeCategory,
    `${uniqueId}-${sanitizeFileName(fileName)}`,
  ].join("/");
}

/**
 * The key prefix all of a company's objects in a category share. Used to verify
 * that a client-supplied key (echoed back to the confirm endpoint) actually
 * belongs to the caller's company before any metadata is trusted.
 */
export function objectKeyPrefix(companyId: string, category: string): string {
  const safeCompany = companyId.replace(/[^A-Za-z0-9]/g, "");
  const safeCategory = category.replace(/[^a-z0-9-]/g, "");
  return [s3Config().prefix, safeCompany, safeCategory, ""].join("/");
}

/** Mints a short-lived URL the browser can PUT a single object to. */
export async function createUploadUrl(params: {
  key: string;
  contentType: string;
  contentLength?: number;
}): Promise<{ uploadUrl: string; expiresIn: number }> {
  const command = new PutObjectCommand({
    Bucket: s3Config().bucket,
    Key: params.key,
    ContentType: params.contentType,
    ...(params.contentLength ? { ContentLength: params.contentLength } : {}),
  });
  const uploadUrl = await getSignedUrl(s3(), command, {
    expiresIn: UPLOAD_URL_TTL_SECONDS,
  });
  return { uploadUrl, expiresIn: UPLOAD_URL_TTL_SECONDS };
}

/** Mints a short-lived URL the browser can GET a single object from. */
export async function createDownloadUrl(params: {
  key: string;
  fileName?: string;
}): Promise<{ downloadUrl: string; expiresIn: number }> {
  const command = new GetObjectCommand({
    Bucket: s3Config().bucket,
    Key: params.key,
    ...(params.fileName
      ? {
          ResponseContentDisposition: `inline; filename="${sanitizeFileName(
            params.fileName,
          )}"`,
        }
      : {}),
  });
  const downloadUrl = await getSignedUrl(s3(), command, {
    expiresIn: DOWNLOAD_URL_TTL_SECONDS,
  });
  return { downloadUrl, expiresIn: DOWNLOAD_URL_TTL_SECONDS };
}

/**
 * Returns object metadata (size, content type) if the key exists, or null if it
 * does not. Used to confirm a presigned upload actually landed before its
 * metadata is persisted.
 */
export async function headObject(
  key: string,
): Promise<{ contentLength: number; contentType?: string } | null> {
  try {
    const result = await s3().send(
      new HeadObjectCommand({ Bucket: s3Config().bucket, Key: key }),
    );
    return {
      contentLength: result.ContentLength ?? 0,
      contentType: result.ContentType,
    };
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "NotFound" || name === "NoSuchKey") return null;
    throw error;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await s3().send(
    new DeleteObjectCommand({ Bucket: s3Config().bucket, Key: key }),
  );
}

/** Server-side upload for bytes the API already holds (chat attachments). */
export async function putObjectBuffer(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: s3Config().bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/** Downloads an object's bytes (company-document text extraction). */
export async function getObjectBuffer(key: string): Promise<Buffer> {
  const result = await s3().send(
    new GetObjectCommand({ Bucket: s3Config().bucket, Key: key }),
  );
  return Buffer.from(await result.Body!.transformToByteArray());
}
