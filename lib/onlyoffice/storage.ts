import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

import {
  copyObject,
  deleteObject,
  s3Client,
  s3Config,
  sanitizeFileName,
} from "@/lib/storage/s3";

import { onlyOfficeEnv } from "./env";
import { WORKSPACE_MAX_FILE_BYTES } from "./formats";

function safeId(value: string): string {
  return value.replace(/[^0-9A-Za-z_-]/g, "");
}

export function workspaceIncomingKey(companyId: string, fileName: string): string {
  return [
    onlyOfficeEnv().storagePrefix,
    safeId(companyId),
    "incoming",
    `${randomUUID()}-${sanitizeFileName(fileName)}`,
  ].join("/");
}

export function workspacePendingKey(companyId: string, documentId: string): string {
  return [
    onlyOfficeEnv().storagePrefix,
    safeId(companyId),
    safeId(documentId),
    "pending",
    randomUUID(),
  ].join("/");
}

export function workspaceVersionKey(input: {
  companyId: string;
  documentId: string;
  storageRevision: number;
  extension: string;
}): string {
  return [
    onlyOfficeEnv().storagePrefix,
    safeId(input.companyId),
    safeId(input.documentId),
    "versions",
    `${input.storageRevision}-${randomUUID()}.${input.extension.replace(/[^a-z0-9]/g, "")}`,
  ].join("/");
}

export async function hashStoredObject(key: string): Promise<{ sha256: string; size: number }> {
  const response = await s3Client().send(
    new GetObjectCommand({ Bucket: s3Config().bucket, Key: key }),
  );
  if (!response.Body) throw new Error("Stored object has no body");
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > WORKSPACE_MAX_FILE_BYTES) throw new Error("file_too_large");
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), size };
}

export async function streamResponseToObject(input: {
  response: Response;
  key: string;
  contentType: string;
}): Promise<{ sha256: string; size: number }> {
  if (!input.response.ok || !input.response.body) {
    throw new Error(`ONLYOFFICE download failed with HTTP ${input.response.status}`);
  }
  const announced = Number(input.response.headers.get("content-length") || 0);
  if (announced > WORKSPACE_MAX_FILE_BYTES) throw new Error("file_too_large");

  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      if (size > WORKSPACE_MAX_FILE_BYTES) {
        callback(new Error("file_too_large"));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const body = Readable.fromWeb(
    input.response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
  ).pipe(meter);

  try {
    await new Upload({
      client: s3Client(),
      params: {
        Bucket: s3Config().bucket,
        Key: input.key,
        Body: body,
        ContentType: input.contentType,
      },
    }).done();
  } catch (error) {
    await deleteObject(input.key).catch(() => undefined);
    throw error;
  }
  return { sha256: hash.digest("hex"), size };
}

export async function promotePendingObject(input: {
  pendingKey: string;
  finalKey: string;
  contentType: string;
  sourceBucket?: string;
}): Promise<void> {
  await copyObject({
    sourceBucket: input.sourceBucket ?? s3Config().bucket,
    sourceKey: input.pendingKey,
    targetKey: input.finalKey,
    contentType: input.contentType,
  });
  if (!input.sourceBucket || input.sourceBucket === s3Config().bucket) {
    await deleteObject(input.pendingKey).catch(() => undefined);
  }
}
