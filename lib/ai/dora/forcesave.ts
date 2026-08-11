import { connectMongoose } from "../../db/mongoose.ts";
import { WorkspaceDocument } from "../../../models/workspace-document.ts";
import { logger } from "../../ingestion/observability/logger.ts";
import { onlyOfficeEnabled, onlyOfficeEnv } from "../../onlyoffice/env.ts";
import { signOnlyOfficeConfig } from "../../onlyoffice/tokens.ts";

const log = logger.child("ai.dora.forcesave");

const POLL_INTERVAL_MS = 750;
const DEFAULT_TIMEOUT_MS = 12_000;

export interface ForcesaveResult {
  /**
   * fresh   — nothing unsaved; the committed version already IS the latest.
   * saved   — the editor flushed; a new version was committed and re-resolved.
   * timeout — the save did not land in time (or errored); analysis proceeds
   *           on the LAST COMMITTED version and the UI says so.
   */
  outcome: "fresh" | "saved" | "timeout";
  storageRevision: number;
}

/**
 * Ask the Document Server to flush the open editor's unsaved changes, then
 * wait for the status-6 callback to commit them as a new version (visible as
 * a `storageRevision` bump). The command-service request is signed exactly
 * like the converter's (Community Edition supports this; no plugin needed).
 *
 * DS `error` mapping: 0 = accepted → poll; 4 = no unsaved changes and
 * 1 = no active session for the key → already fresh; anything else → the
 * timeout fallback. Skipped entirely when nobody has the document open.
 */
export async function forcesaveAndWait(input: {
  documentId: string;
  timeoutMs?: number;
}): Promise<ForcesaveResult> {
  await connectMongoose();
  const document = await WorkspaceDocument.findOne({
    _id: input.documentId,
    deletedAt: null,
  }).lean();
  if (!document) return { outcome: "fresh", storageRevision: 0 };

  const startRevision = document.storageRevision;
  if (!onlyOfficeEnabled() || (document.activeUserIds ?? []).length === 0) {
    return { outcome: "fresh", storageRevision: startRevision };
  }

  const body: Record<string, unknown> = {
    c: "forcesave",
    key: document.activeEditorKey,
    userdata: "dora",
  };
  let error: number;
  try {
    const token = await signOnlyOfficeConfig(body);
    const response = await fetch(`${onlyOfficeEnv().internalUrl}/command`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...body, token }),
      cache: "no-store",
    });
    if (!response.ok) {
      log.warn("forcesave command rejected", { status: response.status });
      return { outcome: "timeout", storageRevision: startRevision };
    }
    error = ((await response.json()) as { error?: number }).error ?? 0;
  } catch (cause) {
    log.warn("forcesave command failed", { error: String(cause).slice(0, 200) });
    return { outcome: "timeout", storageRevision: startRevision };
  }

  if (error === 4 || error === 1) {
    return { outcome: "fresh", storageRevision: startRevision };
  }
  if (error !== 0) {
    log.warn("forcesave returned error code", { code: error });
    return { outcome: "timeout", storageRevision: startRevision };
  }

  const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const current = await WorkspaceDocument.findOne(
      { _id: input.documentId },
      { storageRevision: 1 },
    ).lean();
    if (!current) break;
    if (current.storageRevision > startRevision) {
      return { outcome: "saved", storageRevision: current.storageRevision };
    }
  }
  return { outcome: "timeout", storageRevision: startRevision };
}
