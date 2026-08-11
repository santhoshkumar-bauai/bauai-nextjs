import { deleteObject } from "@/lib/storage/s3";
import { connectMongoose } from "@/lib/db/mongoose";
import { WorkspaceDocument } from "@/models/workspace-document";
import { WorkspaceDocumentVersion } from "@/models/workspace-document-version";

import { onlyOfficeDocumentKey } from "./key";
import { enqueueOnlyOfficeConversion } from "./queue";

/** Repairs interrupted callback commits and clears recorded orphan versions. */
export async function reconcileOnlyOfficeState(): Promise<void> {
  await connectMongoose();
  const incomplete = await WorkspaceDocumentVersion.find({
    state: "committed",
    callbackStatus: { $in: [2, 6] },
    editorKey: { $type: "string" },
  }).sort({ createdAt: 1 }).limit(100);

  for (const version of incomplete) {
    const document = await WorkspaceDocument.findOne({
      _id: version.documentId,
      activeEditorKey: version.editorKey,
      currentVersionId: { $ne: version._id },
      deletedAt: null,
    });
    if (!document) continue;
    const final = version.callbackStatus === 2;
    const editorRevision = final ? document.editorRevision + 1 : document.editorRevision;
    await WorkspaceDocument.updateOne(
      { _id: document._id, activeEditorKey: version.editorKey },
      {
        $set: {
          currentVersionId: version._id,
          state: "ready",
          stateError: null,
          ...(final
            ? {
                editorRevision,
                activeEditorKey: onlyOfficeDocumentKey({
                  documentId: String(document._id),
                  editorRevision,
                }),
                activeUserIds: [],
              }
            : {}),
        },
      },
    );
  }

  const cutoff = new Date(Date.now() - 60 * 60 * 1_000);
  const orphans = await WorkspaceDocumentVersion.find({
    state: "orphan",
    updatedAt: { $lt: cutoff },
  }).limit(100);
  for (const orphan of orphans) {
    await deleteObject(orphan.s3Key).catch(() => undefined);
    await orphan.deleteOne();
  }

  const converting = await WorkspaceDocument.find({
    state: "converting",
    deletedAt: null,
  }).select({ _id: 1 }).limit(100).lean();
  for (const document of converting) {
    await enqueueOnlyOfficeConversion(String(document._id)).catch(() => undefined);
  }
}
