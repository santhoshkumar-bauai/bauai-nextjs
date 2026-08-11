import { jwtVerify } from "jose";

import { deleteObject, s3Config } from "@/lib/storage/s3";
import { connectMongoose } from "@/lib/db/mongoose";
import { WorkspaceDocument } from "@/models/workspace-document";
import { WorkspaceDocumentVersion } from "@/models/workspace-document-version";

import { onlyOfficeEnv } from "./env";
import { editorRevisionAfterCallback, onlyOfficeDocumentKey } from "./key";
import {
  promotePendingObject,
  streamResponseToObject,
  workspacePendingKey,
  workspaceVersionKey,
} from "./storage";

export type OnlyOfficeCallback = {
  key: string;
  status: number;
  url?: string;
  users?: string[];
  actions?: Array<{ type: number; userid: string }>;
  forcesavetype?: number;
  history?: Record<string, unknown>;
  changesurl?: string;
  serverVersion?: string;
  token?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameSignedField(
  visible: Record<string, unknown>,
  signed: Record<string, unknown>,
  key: string,
): boolean {
  if (!(key in visible)) return true;
  return JSON.stringify(visible[key]) === JSON.stringify(signed[key]);
}

export async function verifyOnlyOfficeCallback(
  request: Request,
  body: Record<string, unknown>,
): Promise<OnlyOfficeCallback> {
  const header = request.headers.get("authorization");
  const headerToken = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
  const token = typeof body.token === "string" ? body.token : headerToken;
  if (!token) throw new Error("Missing callback token");

  const result = await jwtVerify(token, new TextEncoder().encode(onlyOfficeEnv().jwtSecret), {
    algorithms: ["HS256"],
  });
  const claims = result.payload as Record<string, unknown>;
  const signed = isRecord(claims.payload) ? claims.payload : claims;
  const visibleKeys = Object.keys(body).filter((key) => key !== "token");
  const callbackSource = visibleKeys.length === 0 ? signed : body;
  for (const key of ["key", "status", "url", "users", "actions", "forcesavetype"]) {
    if (!sameSignedField(body, signed, key)) throw new Error(`Unsigned callback field: ${key}`);
  }
  if (typeof callbackSource.key !== "string" || typeof callbackSource.status !== "number") {
    throw new Error("Invalid callback payload");
  }
  return callbackSource as OnlyOfficeCallback;
}

export function normalizeOnlyOfficeDownloadUrl(raw: string): string {
  const env = onlyOfficeEnv();
  const input = new URL(raw);
  if (input.protocol !== "http:" && input.protocol !== "https:") {
    throw new Error("Unsupported callback URL protocol");
  }
  const publicOrigin = new URL(env.publicUrl).origin;
  const internal = new URL(env.internalUrl);
  if (input.origin !== publicOrigin && input.origin !== internal.origin) {
    throw new Error("Callback URL host is not an ONLYOFFICE host");
  }
  if (input.origin === publicOrigin) {
    input.protocol = internal.protocol;
    input.host = internal.host;
  }
  return input.toString();
}

export async function processOnlyOfficeCallback(
  documentId: string,
  callback: OnlyOfficeCallback,
): Promise<void> {
  await connectMongoose();
  const document = await WorkspaceDocument.findOne({ _id: documentId, deletedAt: null });
  if (!document) throw new Error("Document not found");

  if (callback.key !== document.activeEditorKey) {
    // A retried final callback can arrive after the successful save rotated the key.
    return;
  }

  const now = new Date();
  if (callback.status === 1) {
    document.activeUserIds = Array.from(new Set(callback.users ?? []));
    document.lastCallbackAt = now;
    await document.save();
    return;
  }
  if (callback.status === 4) {
    document.activeUserIds = [];
    document.lastCallbackAt = now;
    await document.save();
    return;
  }
  if (callback.status === 3 || callback.status === 7) {
    document.state = "save_failed";
    document.stateError = callback.status === 3 ? "final_save_failed" : "forcesave_failed";
    document.lastCallbackAt = now;
    await document.save();
    return;
  }
  if (callback.status !== 2 && callback.status !== 6) return;
  if (!callback.url) throw new Error("Save callback did not contain a download URL");

  const pendingKey = workspacePendingKey(String(document.companyId), documentId);
  try {
    const response = await fetch(normalizeOnlyOfficeDownloadUrl(callback.url), {
      cache: "no-store",
      redirect: "error",
    });
    const stored = await streamResponseToObject({
      response,
      key: pendingKey,
      contentType: document.contentType,
    });
    const duplicate = await WorkspaceDocumentVersion.findOne({
      documentId: document._id,
      editorKey: callback.key,
      callbackStatus: callback.status,
      sha256: stored.sha256,
      state: "committed",
    }).lean();
    if (duplicate) {
      await deleteObject(pendingKey).catch(() => undefined);
      const nextRevision = editorRevisionAfterCallback(document.editorRevision, callback.status);
      await WorkspaceDocument.updateOne(
        { _id: document._id, activeEditorKey: callback.key },
        {
          $set: {
            currentVersionId: duplicate._id,
            state: "ready",
            stateError: null,
            ...(callback.status === 2
              ? {
                  editorRevision: nextRevision,
                  activeEditorKey: onlyOfficeDocumentKey({ documentId, editorRevision: nextRevision }),
                  activeUserIds: [],
                }
              : {}),
          },
        },
      );
      return;
    }

    const reserved = await WorkspaceDocument.findOneAndUpdate(
      { _id: document._id, activeEditorKey: callback.key, deletedAt: null },
      {
        $inc: { storageRevision: 1 },
        $set: { lastCallbackAt: now, updatedBy: callback.users?.[0] ?? "onlyoffice" },
      },
      { new: true },
    );
    if (!reserved) throw new Error("Editor session changed while saving");

    const finalKey = workspaceVersionKey({
      companyId: String(reserved.companyId),
      documentId,
      storageRevision: reserved.storageRevision,
      extension: reserved.extension,
    });
    await promotePendingObject({
      pendingKey,
      finalKey,
      contentType: reserved.contentType,
    });
    const version = await WorkspaceDocumentVersion.create({
      companyId: reserved.companyId,
      documentId: reserved._id,
      storageRevision: reserved.storageRevision,
      editorRevision: reserved.editorRevision,
      reason: callback.status === 6 ? "forcesave" : "final",
      state: "committed",
      s3Bucket: s3Config().bucket,
      s3Key: finalKey,
      fileName: reserved.fileName,
      extension: reserved.extension,
      contentType: reserved.contentType,
      size: stored.size,
      sha256: stored.sha256,
      editorKey: callback.key,
      callbackStatus: callback.status,
      onlyofficeHistory: callback.history ?? null,
      serverVersion: callback.serverVersion ?? null,
      createdBy: callback.users?.[0] ?? "onlyoffice",
    });

    const nextRevision = editorRevisionAfterCallback(reserved.editorRevision, callback.status);
    const update = await WorkspaceDocument.updateOne(
      {
        _id: reserved._id,
        activeEditorKey: callback.key,
        storageRevision: reserved.storageRevision,
      },
      {
        $set: {
          currentVersionId: version._id,
          state: "ready",
          stateError: null,
          updatedBy: callback.users?.[0] ?? "onlyoffice",
          ...(callback.status === 2
            ? {
                editorRevision: nextRevision,
                activeEditorKey: onlyOfficeDocumentKey({
                  documentId,
                  editorRevision: nextRevision,
                }),
                activeUserIds: [],
              }
            : {}),
        },
      },
    );
    if (update.modifiedCount !== 1) {
      await WorkspaceDocumentVersion.updateOne({ _id: version._id }, { state: "orphan" });
      throw new Error("Document head changed before the saved version was committed");
    }
  } catch (error) {
    await deleteObject(pendingKey).catch(() => undefined);
    throw error;
  }
}
