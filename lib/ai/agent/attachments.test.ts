import { ObjectId } from "mongodb";
import { HumanMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatAttachmentDocument } from "../types.ts";

vi.mock("../../storage/s3.ts", () => ({
  buildObjectKey: vi.fn(() => "companies/x/chat/key"),
  putObjectBuffer: vi.fn(),
  getObjectBuffer: vi.fn(),
}));
vi.mock("../../ingestion/documents/text-extract.ts", () => ({
  extractText: vi.fn(),
}));
vi.mock("../db/collections.ts", () => ({ getAiCollections: vi.fn() }));

const s3 = await import("../../storage/s3.ts");
const { buildUserTurnContent, resolveMediaParts } = await import("./attachments.ts");

function doc(overrides: Partial<ChatAttachmentDocument>): ChatAttachmentDocument {
  return {
    _id: new ObjectId(),
    tenantId: new ObjectId(),
    userId: "u",
    fileName: "file.bin",
    contentType: "application/octet-stream",
    size: 1000,
    s3Key: "companies/x/chat/key",
    status: "ready",
    text: "",
    claimed: true,
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(s3.getObjectBuffer).mockReset();
});

describe("buildUserTurnContent", () => {
  it("inlines extracted text for non-native documents", () => {
    const content = buildUserTurnContent("check this", [
      doc({ fileName: "notes.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", text: "hello world" }),
    ]);
    expect(typeof content).toBe("string");
    expect(content).toContain("check this");
    expect(content).toContain("<document>hello world</document>");
  });

  it("emits media_ref parts for PDFs (with fallback) and images", () => {
    const content = buildUserTurnContent("look", [
      doc({ fileName: "spec.pdf", contentType: "application/pdf", text: "extract" }),
      doc({ fileName: "site.png", contentType: "image/png" }),
    ]) as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toMatchObject({ type: "text", text: "look" });
    expect(content[1]).toMatchObject({
      type: "media_ref",
      mimeType: "application/pdf",
      fallbackText: "extract",
    });
    expect(content[2]).toMatchObject({ type: "media_ref", mimeType: "image/png" });
  });

  it("flags unreadable files instead of dropping them", () => {
    const content = buildUserTurnContent("", [
      doc({ fileName: "data.zip", contentType: "application/zip", status: "unsupported" }),
    ]);
    expect(content).toContain('"data.zip"');
    expect(content).toContain("could not be read");
  });
});

describe("resolveMediaParts", () => {
  it("resolves images to data URLs and PDFs to standard file blocks", async () => {
    vi.mocked(s3.getObjectBuffer).mockResolvedValue(Buffer.from("PDF"));
    const message = new HumanMessage({
      content: [
        { type: "text", text: "q" },
        { type: "media_ref", s3Key: "k1", mimeType: "image/png", fileName: "a.png" },
        { type: "media_ref", s3Key: "k2", mimeType: "application/pdf", fileName: "b.pdf" },
      ] as never,
    });
    const [resolved] = await resolveMediaParts([message], new Map());
    const parts = resolved.content as Array<Record<string, unknown>>;
    expect(parts[1]).toMatchObject({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${Buffer.from("PDF").toString("base64")}` },
    });
    expect(parts[2]).toMatchObject({
      type: "file",
      source_type: "base64",
      mime_type: "application/pdf",
      metadata: { filename: "b.pdf" },
    });
  });

  it("degrades to fallback text when the object is gone", async () => {
    vi.mocked(s3.getObjectBuffer).mockRejectedValue(new Error("gone"));
    const message = new HumanMessage({
      content: [
        { type: "media_ref", s3Key: "k", mimeType: "application/pdf", fileName: "b.pdf", fallbackText: "the extract" },
      ] as never,
    });
    const [resolved] = await resolveMediaParts([message], new Map());
    const parts = resolved.content as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({ type: "text" });
    expect(String(parts[0].text)).toContain("<document>the extract</document>");
  });

  it("leaves plain-string messages untouched", async () => {
    const message = new HumanMessage("just text");
    const [resolved] = await resolveMediaParts([message], new Map());
    expect(resolved).toBe(message);
  });
});
