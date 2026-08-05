import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { assertS3Configured, ingestionEnv } from "../config/env.ts";
import { logger } from "../observability/logger.ts";
import { metrics } from "../observability/metrics.ts";
import { sha256 } from "../utils/hash.ts";

const log = logger.child("documents.store");

/**
 * S3 storage for retrieved tender documents.
 *
 * Same discipline as `storage/raw-payload-store.ts` — upload, verify the checksum,
 * only then hand back a reference — but documents are stored uncompressed. PDFs and
 * ZIPs are already compressed, so gzipping them again costs CPU for nothing, and
 * keeping the original bytes byte-for-byte is what makes the stored file
 * independently openable.
 */
let client: S3Client | null = null;

function s3(): S3Client {
  if (client) return client;
  assertS3Configured();
  client = new S3Client({
    region: ingestionEnv.s3.region,
    endpoint: ingestionEnv.s3.endpoint,
    credentials: {
      accessKeyId: ingestionEnv.s3.keyId,
      secretAccessKey: ingestionEnv.s3.applicationKey,
    },
    forcePathStyle: true,
  });
  return client;
}

/**
 * Content-addressed key. Two tenders referencing the same file converge on one
 * object, and a re-run overwrites nothing because the hash is part of the path.
 */
export function documentKey(
  canonicalKey: string,
  fileName: string,
  contentSha256: string,
): string {
  const safeTender = canonicalKey.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 100);
  const safeName = sanitizeFileName(fileName);
  return [
    ingestionEnv.documents.prefix,
    contentSha256.slice(0, 2),
    safeTender,
    `${contentSha256.slice(0, 12)}__${safeName}`,
  ].join("/");
}

export function textKey(documentObjectKey: string): string {
  return `${documentObjectKey}.txt`;
}

/**
 * Strips path separators and control characters from a portal-supplied name. The
 * name reaches us from an HTML attribute or a `Content-Disposition` header, so it is
 * untrusted input that must never influence the object path.
 */
export function sanitizeFileName(fileName: string): string {
  const base = fileName.replace(/\\/g, "/").split("/").pop() ?? "document";
  let cleaned = "";
  for (const char of base) {
    cleaned += char.charCodeAt(0) < 0x20 ? "_" : char;
  }
  cleaned = cleaned.replace(/[^A-Za-z0-9._()+-]/g, "_").replace(/_+/g, "_").trim();
  return (cleaned || "document").slice(0, 150);
}

export interface StoredObject {
  bucket: string;
  key: string;
  reused: boolean;
}

export async function storeDocumentFile(input: {
  canonicalKey: string;
  fileName: string;
  body: Buffer;
  mimeType: string;
  sourceUrl: string;
}): Promise<StoredObject & { sha256: string }> {
  const contentSha256 = sha256(input.body);
  const key = documentKey(input.canonicalKey, input.fileName, contentSha256);
  const bucket = ingestionEnv.s3.bucket;

  const existing = await headObject(bucket, key);
  if (existing?.Metadata?.sha256 === contentSha256) {
    metrics.increment("ingestion_document_files_reused_total");
    return { bucket, key, reused: true, sha256: contentSha256 };
  }

  await s3().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: input.body,
      ContentType: input.mimeType,
      // The original name is preserved so a download serves it back correctly.
      ContentDisposition: `attachment; filename="${sanitizeFileName(input.fileName)}"`,
      Metadata: {
        sha256: contentSha256,
        "source-url": input.sourceUrl.slice(0, 900),
        "canonical-key": input.canonicalKey.slice(0, 200),
      },
    }),
  );

  const head = await headObject(bucket, key);
  if (!head) throw new Error(`Document upload could not be verified: ${key}`);
  if (head.Metadata?.sha256 !== contentSha256) {
    throw new Error(
      `Document checksum mismatch for ${key}: stored ${head.Metadata?.sha256}, expected ${contentSha256}`,
    );
  }

  metrics.increment("ingestion_document_files_stored_total");
  metrics.increment(
    "ingestion_document_bytes_total",
    {},
    input.body.byteLength,
  );
  log.debug("document stored", { key, bytes: input.body.byteLength });

  return { bucket, key, reused: false, sha256: contentSha256 };
}

/** Extracted text always goes to S3, whatever its size. */
export async function storeDocumentText(
  documentObjectKey: string,
  text: string,
): Promise<string> {
  const key = textKey(documentObjectKey);
  await s3().send(
    new PutObjectCommand({
      Bucket: ingestionEnv.s3.bucket,
      Key: key,
      Body: Buffer.from(text, "utf8"),
      ContentType: "text/plain; charset=utf-8",
    }),
  );
  return key;
}

export async function loadDocumentFile(bucket: string, key: string): Promise<Buffer> {
  const response = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await response.Body!.transformToByteArray());
}

async function headObject(bucket: string, key: string) {
  try {
    return await s3().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "NotFound" || name === "NoSuchKey") return null;
    throw error;
  }
}
