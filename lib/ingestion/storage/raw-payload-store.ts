import { gunzipSync, gzipSync } from "node:zlib";

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { assertS3Configured, ingestionEnv } from "../config/env.ts";
import { getIngestionDb } from "../db/client.ts";
import { logger } from "../observability/logger.ts";
import { metrics } from "../observability/metrics.ts";
import type { RawNotice, RawPayloadRef, TenderSourceCode } from "../types.ts";
import { sha256 } from "../utils/hash.ts";

const log = logger.child("raw-store");

/**
 * Raw payload storage for `tender_notices.raw`.
 *
 * Architecture section 6.9 specifies GridFS; this deployment uses the already
 * configured S3-compatible bucket instead. The contract it actually depends on is
 * unchanged: neither GridFS nor S3 participates in a MongoDB transaction, so the
 * payload is uploaded and checksum-verified *first*, only a reference and hash go
 * into the short transaction, and a sweeper removes uploads whose transaction
 * never committed.
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
    // Cloudflare R2, Backblaze B2, and MinIO all address objects as
    // `<endpoint>/<bucket>/<key>`, so virtual-hosted style must be off.
    forcePathStyle: true,
  });
  return client;
}

/**
 * Verifies the bucket end to end with one small object: upload, checksum-verify,
 * read back, delete. Used by the Phase 1 gate, because a misconfigured bucket
 * otherwise surfaces as a failed notice rather than a failed deployment.
 */
export async function checkRawStoreAccess(): Promise<{ ok: boolean; detail: string }> {
  assertS3Configured();
  const key = `${ingestionEnv.s3.prefix}/.access-check/${ingestionEnv.workerId}.txt`;
  const body = Buffer.from(`bau-ai ingestion access check ${new Date().toISOString()}`);
  const bucket = ingestionEnv.s3.bucket;

  try {
    await s3().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: "text/plain",
        Metadata: { sha256: sha256(body) },
      }),
    );

    const head = await headObject(bucket, key);
    if (!head) return { ok: false, detail: `uploaded object ${key} was not readable` };

    const read = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const roundTripped = Buffer.from(await read.Body!.transformToByteArray());
    if (sha256(roundTripped) !== sha256(body)) {
      return { ok: false, detail: `round-tripped bytes did not match for ${key}` };
    }

    return {
      ok: true,
      detail: `bucket ${bucket} at ${ingestionEnv.s3.endpoint} accepts and returns objects`,
    };
  } catch (error) {
    return { ok: false, detail: String(error) };
  } finally {
    // The probe object is always removed, whether or not the check succeeded.
    await s3()
      .send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: [{ Key: key }], Quiet: true } }))
      .catch(() => undefined);
  }
}

interface UploadReceipt {
  _id: string;
  bucket: string;
  sha256: string;
  byteLength: number;
  committed: boolean;
  createdAt: Date;
  source: TenderSourceCode;
}

const receiptsCollection = "raw_upload_receipts";

async function receipts() {
  const db = await getIngestionDb();
  return db.collection<UploadReceipt>(receiptsCollection);
}

/**
 * Deterministic key so replaying the same source version overwrites the same
 * object instead of accumulating copies. Includes the content hash because a
 * corrected notice that reuses a version key must not clobber the earlier bytes.
 */
export function rawPayloadKey(
  source: TenderSourceCode,
  sourceNoticeId: string,
  versionKey: string,
  contentSha256: string,
  extension: string,
): string {
  const safeNoticeId = sourceNoticeId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  const safeVersion = versionKey.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  const shard = contentSha256.slice(0, 2);
  return [
    ingestionEnv.s3.prefix,
    source,
    shard,
    `${safeNoticeId}__${safeVersion}__${contentSha256.slice(0, 12)}.${extension}.gz`,
  ].join("/");
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes("json")) return "json";
  if (mimeType.includes("xml")) return "xml";
  if (mimeType.includes("csv")) return "csv";
  return "bin";
}

export interface StoredPayload {
  ref: RawPayloadRef;
  /** True when the object already existed with the same content hash. */
  reused: boolean;
}

/** Uploads, verifies, and records a receipt. Safe to call repeatedly. */
export async function storeRawPayload(
  raw: RawNotice,
  versionKey: string,
): Promise<StoredPayload> {
  const key = rawPayloadKey(
    raw.source,
    raw.sourceNoticeId,
    versionKey,
    raw.sha256,
    extensionFor(raw.mimeType),
  );
  const bucket = ingestionEnv.s3.bucket;
  const ref: RawPayloadRef = {
    storage: "s3",
    bucket,
    key,
    mimeType: raw.mimeType,
    compression: "gzip",
    byteLength: raw.byteLength,
    sha256: raw.sha256,
  };

  const existing = await headObject(bucket, key);
  if (existing?.Metadata?.sha256 === raw.sha256) {
    await recordReceipt(key, ref, raw.source);
    metrics.increment("ingestion_raw_payload_reused_total", { source: raw.source });
    return { ref, reused: true };
  }

  const compressed = gzipSync(raw.body, { level: 6 });

  await s3().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: compressed,
      ContentType: raw.mimeType,
      ContentEncoding: "gzip",
      Metadata: {
        sha256: raw.sha256,
        source: raw.source,
        "notice-id": raw.sourceNoticeId.slice(0, 200),
        "byte-length": String(raw.byteLength),
        licence: raw.licence,
      },
    }),
  );

  // Verify before the reference is allowed anywhere near MongoDB; an unverified
  // reference would make the notice unreplayable after a parser change (§13.3).
  const head = await headObject(bucket, key);
  if (!head) {
    throw new Error(`Raw payload upload could not be verified: ${key}`);
  }
  if (head.Metadata?.sha256 !== raw.sha256) {
    throw new Error(
      `Raw payload checksum mismatch for ${key}: stored ${head.Metadata?.sha256}, expected ${raw.sha256}`,
    );
  }

  await recordReceipt(key, ref, raw.source);
  metrics.increment("ingestion_raw_payload_stored_total", { source: raw.source });
  // A counter of bytes written, not a histogram: byte sizes do not belong in the
  // millisecond buckets the latency histograms use.
  metrics.increment(
    "ingestion_raw_payload_bytes_total",
    { source: raw.source },
    compressed.byteLength,
  );

  return { ref, reused: false };
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

async function recordReceipt(
  key: string,
  ref: RawPayloadRef,
  source: TenderSourceCode,
): Promise<void> {
  const store = await receipts();
  await store.updateOne(
    { _id: key },
    {
      $setOnInsert: {
        bucket: ref.bucket,
        sha256: ref.sha256,
        byteLength: ref.byteLength,
        committed: false,
        createdAt: new Date(),
        source,
      },
    },
    { upsert: true },
  );
}

/**
 * Marks an upload as referenced by a committed notice. Called after the MongoDB
 * transaction succeeds, which is what lets the sweeper distinguish an orphan
 * from a payload that is simply new.
 */
export async function commitRawPayload(ref: RawPayloadRef): Promise<void> {
  const store = await receipts();
  await store.updateOne({ _id: ref.key }, { $set: { committed: true } });
}

export async function loadRawPayload(ref: RawPayloadRef): Promise<Buffer> {
  const response = await s3().send(
    new GetObjectCommand({ Bucket: ref.bucket, Key: ref.key }),
  );
  const compressed = Buffer.from(await response.Body!.transformToByteArray());
  const body = ref.compression === "gzip" ? gunzipSync(compressed) : compressed;

  const actual = sha256(body);
  if (actual !== ref.sha256) {
    throw new Error(
      `Raw payload ${ref.key} failed checksum verification on read: ${actual} != ${ref.sha256}`,
    );
  }
  return body;
}

/**
 * Deletes uploads whose transaction never committed. The delay must exceed the
 * longest possible processing time so an in-flight job is never swept.
 */
export async function sweepOrphanPayloads(
  olderThanMs = 6 * 60 * 60 * 1000,
  limit = 1_000,
): Promise<number> {
  const store = await receipts();
  const cutoff = new Date(Date.now() - olderThanMs);
  const orphans = await store
    .find({ committed: false, createdAt: { $lt: cutoff } })
    .limit(limit)
    .toArray();

  if (!orphans.length) return 0;

  for (let i = 0; i < orphans.length; i += 1000) {
    const batch = orphans.slice(i, i + 1000);
    await s3().send(
      new DeleteObjectsCommand({
        Bucket: ingestionEnv.s3.bucket,
        Delete: { Objects: batch.map((o) => ({ Key: o._id })), Quiet: true },
      }),
    );
    await store.deleteMany({ _id: { $in: batch.map((o) => o._id) } });
  }

  log.warn("swept orphan raw payloads", { count: orphans.length });
  metrics.increment("ingestion_raw_payload_orphans_swept_total", {}, orphans.length);
  return orphans.length;
}

export async function ensureRawStoreIndexes(): Promise<void> {
  const store = await receipts();
  await store.createIndex({ committed: 1, createdAt: 1 }, { name: "ix_orphan_sweep" });
}
