import { ObjectId } from "mongodb";

import type { BaseMessage, MessageContentComplex } from "@langchain/core/messages";

import { extractText } from "../../ingestion/documents/text-extract.ts";
import {
  buildObjectKey,
  getObjectBuffer,
  putObjectBuffer,
} from "../../storage/s3.ts";
import { getAiCollections } from "../db/collections.ts";
import type { ChatAttachmentDocument, ChatMessageAttachment } from "../types.ts";

/**
 * Chat attachments, fed DIRECTLY into the model interface:
 * - Documents (PDF/DOCX/text formats): text is extracted at upload and rides
 *   inside the user turn as <document> blocks.
 * - Images: passed to the model as native vision input. The checkpointed
 *   message stores only a tiny `media_ref` part (S3 key); the base64 payload
 *   is resolved at model-call time so checkpoints never carry image bytes.
 * - Anything else: attached and acknowledged, flagged as not readable.
 * Raw bytes always land in S3 (chat category under the tenant's prefix).
 */

export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
/** Per-file extract cap; 4 files ≈ 60k chars ≈ well inside the model window. */
const ATTACHMENT_TEXT_CAP = 15_000;
/** Vision-capable types across Gemini / OpenAI / Anthropic adapters. */
const INLINE_IMAGE_TYPES = /^image\/(png|jpe?g|webp|gif)$/i;
/** Base64 inflates ~4/3; keep single requests and per-call payloads sane. */
const INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** PDFs at/below this go to the model NATIVELY (layout, tables, scans). */
const NATIVE_PDF_MAX_BYTES = 8 * 1024 * 1024;

/** Checkpoint-friendly stand-in for a binary part; resolved per model call. */
export interface MediaRefPart {
  type: "media_ref";
  s3Key: string;
  mimeType: string;
  fileName: string;
  /** Extracted text used if the object is gone or native input fails. */
  fallbackText?: string;
}

export function isInlineImage(doc: ChatAttachmentDocument): boolean {
  return (
    INLINE_IMAGE_TYPES.test(doc.contentType) &&
    doc.size <= INLINE_IMAGE_MAX_BYTES &&
    doc.s3Key !== null
  );
}

/**
 * Native-document path: all three provider adapters convert LangChain's
 * standard base64 file block into their own document input (Gemini
 * inlineData, Anthropic document block, OpenAI file part), which reads
 * layout, tables and scanned pages far better than a text extract.
 */
export function isNativeDocument(doc: ChatAttachmentDocument): boolean {
  return (
    /^application\/pdf$/i.test(doc.contentType) &&
    doc.size <= NATIVE_PDF_MAX_BYTES &&
    doc.s3Key !== null
  );
}

export async function storeChatAttachment(input: {
  tenantId: ObjectId;
  userId: string;
  fileName: string;
  contentType: string;
  bytes: Buffer;
}): Promise<ChatAttachmentDocument> {
  const _id = new ObjectId();
  const s3Key = buildObjectKey({
    companyId: input.tenantId.toHexString(),
    category: "chat",
    fileName: input.fileName,
    uniqueId: _id.toHexString(),
  });
  await putObjectBuffer(s3Key, input.bytes, input.contentType);

  const isPdf = /^application\/pdf$/i.test(input.contentType);
  const nativePdf = isPdf && input.bytes.byteLength <= NATIVE_PDF_MAX_BYTES;

  let status: ChatAttachmentDocument["status"];
  let text = "";
  if (INLINE_IMAGE_TYPES.test(input.contentType)) {
    // Images skip text extraction — the model sees the pixels.
    status = input.bytes.byteLength <= INLINE_IMAGE_MAX_BYTES ? "ready" : "unsupported";
  } else {
    const extracted = await extractText(input.bytes, input.contentType, input.fileName);
    const hasText = extracted.status === "DONE" && extracted.text.trim().length > 0;
    // Native-path PDFs are readable even with no text layer (scans) — the
    // model reads the pages directly; the extract is only a fallback.
    status = hasText || nativePdf ? "ready" : extracted.status === "FAILED" ? "failed" : "unsupported";
    text = hasText ? extracted.text.slice(0, ATTACHMENT_TEXT_CAP) : "";
  }

  const doc: ChatAttachmentDocument = {
    _id,
    tenantId: input.tenantId,
    userId: input.userId,
    fileName: input.fileName,
    contentType: input.contentType,
    size: input.bytes.byteLength,
    s3Key,
    status,
    text,
    claimed: false,
    createdAt: new Date(),
  };
  const { chatAttachments } = await getAiCollections();
  await chatAttachments.insertOne(doc as never);
  return doc;
}

/**
 * Resolve the ids a message references to the caller's own unclaimed uploads
 * and mark them claimed. Foreign, already-claimed or unknown ids drop out
 * silently — a forged id cannot pull another user's file into a thread.
 */
export async function claimChatAttachments(input: {
  tenantId: ObjectId;
  userId: string;
  ids: string[];
}): Promise<ChatAttachmentDocument[]> {
  const validIds = input.ids
    .filter((id) => ObjectId.isValid(id))
    .slice(0, MAX_ATTACHMENTS_PER_MESSAGE)
    .map((id) => new ObjectId(id));
  if (validIds.length === 0) return [];

  const { chatAttachments } = await getAiCollections();
  const docs = await chatAttachments
    .find({
      _id: { $in: validIds },
      tenantId: input.tenantId,
      userId: input.userId,
      claimed: false,
    })
    .toArray();
  if (docs.length > 0) {
    await chatAttachments.updateMany(
      { _id: { $in: docs.map((doc) => doc._id) } },
      { $set: { claimed: true } },
    );
  }
  return docs as ChatAttachmentDocument[];
}

export function attachmentMeta(doc: ChatAttachmentDocument): ChatMessageAttachment {
  return {
    fileName: doc.fileName,
    contentType: doc.contentType,
    size: doc.size,
    status: doc.status,
  };
}

function textBlocks(docs: ChatAttachmentDocument[]): string {
  const blocks = docs
    .filter((doc) => !isInlineImage(doc) && !isNativeDocument(doc))
    .map((doc) => {
      if (doc.status !== "ready" || !doc.text) {
        return `[Attached file "${doc.fileName}" (${doc.contentType}) could not be read — no text could be extracted from this file type.]`;
      }
      return [
        `Attached file "${doc.fileName}":`,
        `<document>${doc.text}</document>`,
      ].join("\n");
    });
  return blocks.join("\n\n");
}

/**
 * The user turn's model content. Plain string when everything fits as text;
 * otherwise a multimodal part array with `media_ref` stand-ins that
 * `resolveMediaParts` swaps for base64 at call time. Images and PDFs go
 * native; other document types ride as extracted text.
 */
export function buildUserTurnContent(
  userText: string,
  docs: ChatAttachmentDocument[],
): string | MessageContentComplex[] {
  const text = [userText, textBlocks(docs)].filter(Boolean).join("\n\n");
  const media = docs.filter((doc) => isInlineImage(doc) || isNativeDocument(doc));
  if (media.length === 0) return text;

  return [
    ...(text ? [{ type: "text", text } as MessageContentComplex] : []),
    ...media.map(
      (doc): MessageContentComplex =>
        ({
          type: "media_ref",
          s3Key: doc.s3Key!,
          mimeType: doc.contentType,
          fileName: doc.fileName,
          // PDFs keep their extract as a degraded-mode fallback.
          ...(doc.text ? { fallbackText: doc.text } : {}),
        }) as unknown as MessageContentComplex,
    ),
  ];
}

/**
 * Swap `media_ref` parts for provider-ready base64 image parts. Runs on the
 * context window right before every model invocation; `cache` (per turn)
 * keeps repeat iterations from re-downloading the same object.
 */
export async function resolveMediaParts(
  messages: BaseMessage[],
  cache: Map<string, string>,
): Promise<BaseMessage[]> {
  return Promise.all(
    messages.map(async (message) => {
      if (!Array.isArray(message.content)) return message;
      const hasRef = message.content.some(
        (part) => (part as { type?: string }).type === "media_ref",
      );
      if (!hasRef) return message;

      const content = await Promise.all(
        message.content.map(async (part) => {
          const ref = part as unknown as MediaRefPart;
          if (ref.type !== "media_ref") return part;
          let base64 = cache.get(ref.s3Key);
          if (!base64) {
            try {
              const bytes = await getObjectBuffer(ref.s3Key);
              base64 = bytes.toString("base64");
              cache.set(ref.s3Key, base64);
            } catch {
              // Object gone (bucket cleanup): degrade to the extract or a
              // note instead of failing the whole turn.
              return {
                type: "text",
                text: ref.fallbackText
                  ? `Attached file "${ref.fileName}":\n<document>${ref.fallbackText}</document>`
                  : `[Attached file "${ref.fileName}" is no longer available.]`,
              };
            }
          }
          if (ref.mimeType.startsWith("image/")) {
            return {
              type: "image_url",
              image_url: { url: `data:${ref.mimeType};base64,${base64}` },
            };
          }
          // LangChain standard base64 file block — each provider adapter
          // converts it to its native document input (Gemini inlineData,
          // Anthropic document block, OpenAI file part).
          return {
            type: "file",
            source_type: "base64",
            mime_type: ref.mimeType,
            data: base64,
            metadata: { filename: ref.fileName },
          };
        }),
      );
      // Same message class, swapped content — never mutate checkpointed state.
      const Ctor = message.constructor as new (fields: {
        content: typeof content;
      }) => BaseMessage;
      return new Ctor({ content });
    }),
  );
}
