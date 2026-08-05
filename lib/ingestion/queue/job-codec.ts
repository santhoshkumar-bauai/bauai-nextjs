import type { IngestionJob } from "../types.ts";

/**
 * Wire codec for queue messages.
 *
 * `JSON.stringify` turns a Buffer into `{"type":"Buffer","data":[110,...]}`, about
 * four bytes of JSON per payload byte. Base64 costs 1.33x instead, which matters
 * because a single German publication day carries ~850 inline XML documents.
 */
interface WireInlinePayload {
  mimeType: string;
  bodyBase64: string;
}

export function encodeJob(job: IngestionJob): string {
  if (job.kind !== "notice" || !job.notice.inlinePayload) {
    return JSON.stringify(job);
  }

  const { inlinePayload, ...notice } = job.notice;
  const wire = {
    ...job,
    notice: {
      ...notice,
      inlineWire: {
        mimeType: inlinePayload.mimeType,
        bodyBase64: inlinePayload.body.toString("base64"),
      } satisfies WireInlinePayload,
    },
  };
  return JSON.stringify(wire);
}

export function decodeJob(raw: string): IngestionJob {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed.kind !== "notice") return parsed as unknown as IngestionJob;

  const notice = parsed.notice as Record<string, unknown> | undefined;
  const wire = notice?.inlineWire as WireInlinePayload | undefined;
  if (!notice || !wire) return parsed as unknown as IngestionJob;

  delete notice.inlineWire;
  notice.inlinePayload = {
    mimeType: wire.mimeType,
    body: Buffer.from(wire.bodyBase64, "base64"),
  };
  return parsed as unknown as IngestionJob;
}

/** Approximate wire size, used to decide between inlining and staging. */
export function estimateJobBytes(job: IngestionJob): number {
  if (job.kind !== "notice" || !job.notice.inlinePayload) return 1_024;
  return Math.ceil(job.notice.inlinePayload.body.byteLength * 1.37) + 1_024;
}
