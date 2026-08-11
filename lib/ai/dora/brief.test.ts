import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";

import type { DocumentBriefDocument } from "../types.ts";
import type { DoraRunContext } from "./context.ts";

vi.mock("../db/collections.ts", () => ({ getAiCollections: vi.fn() }));

const collections = await import("../db/collections.ts");
const { getBriefState, serializeBrief } = await import("./brief.ts");
const { briefAnalysisSchema, briefContentSchema, DORA_BRIEF_PROMPT_VERSION } =
  await import("./brief-schema.ts");

function briefContent(overrides: Record<string, unknown> = {}) {
  return {
    documentType: "Eigenerklärung",
    purpose: "Self-declaration for eligibility",
    summary: "A form.",
    keyRequirements: [{ text: "Must sign", evidenceIds: ["E1", "GHOST"] }],
    deadlines: [],
    requiredActions: [],
    suggestedValues: [],
    missingInfo: [],
    risks: [],
    ...overrides,
  };
}

function briefDoc(overrides: Partial<DocumentBriefDocument> = {}): DocumentBriefDocument {
  return {
    tenantId: new ObjectId(),
    documentId: new ObjectId(),
    versionId: new ObjectId(),
    versionSha256: "a".repeat(64),
    storageRevision: 3,
    brief: { en: briefContent(), de: briefContent() },
    citations: {
      E1: {
        key: "E1",
        quote: "muss unterschrieben werden",
        fileName: "vertrag.pdf",
        documentRecordId: null,
        chunkId: null,
      },
    },
    textInfo: { status: "ready", source: "native", note: null, chars: 10, truncated: false },
    model: { provider: "gemini", providerModel: "m", promptVersion: DORA_BRIEF_PROMPT_VERSION },
    generatedByUserId: "u1",
    generatedAt: new Date("2026-08-11T00:00:00Z"),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("brief schemas", () => {
  it("the merged content schema accepts one language's full brief", () => {
    expect(briefContentSchema.safeParse(briefContent()).success).toBe(true);
  });

  it("the analysis schema rejects plan-only content", () => {
    const { requiredActions, suggestedValues, ...analysisOnly } = briefContent();
    expect(briefAnalysisSchema.safeParse(analysisOnly).success).toBe(true);
    expect(
      briefAnalysisSchema.safeParse({ requiredActions, suggestedValues }).success,
    ).toBe(false);
  });
});

describe("serializeBrief", () => {
  it("resolves evidence ids to citations and DROPS unknown ids", () => {
    const wire = serializeBrief(briefDoc(), false, "en");
    // E1 resolves; the fabricated "GHOST" id silently disappears.
    expect(wire.keyRequirements[0].citations).toHaveLength(1);
    expect(wire.keyRequirements[0].citations[0].fileName).toBe("vertrag.pdf");
  });

  it("serves the requested locale and carries staleness + text notes", () => {
    const doc = briefDoc({
      brief: {
        en: briefContent({ documentType: "Self-declaration" }),
        de: briefContent({ documentType: "Eigenerklärung" }),
      },
      textInfo: {
        status: "ready",
        source: "converted-csv",
        note: "first_sheet_only",
        chars: 10,
        truncated: false,
      },
    });
    const wire = serializeBrief(doc, true, "de");
    expect(wire.documentType).toBe("Eigenerklärung");
    expect(wire.stale).toBe(true);
    expect(wire.textNote).toBe("first_sheet_only");
    expect(wire.analyzedRevision).toBe(3);
  });
});

describe("getBriefState staleness", () => {
  function ctxFor(doc: DocumentBriefDocument, currentSha: string | null): DoraRunContext {
    vi.mocked(collections.getAiCollections).mockResolvedValue({
      documentBriefs: { findOne: vi.fn(async () => doc) },
    } as never);
    return {
      tenantId: doc.tenantId,
      document: {
        documentId: doc.documentId,
        version: currentSha
          ? { sha256: currentSha, id: new ObjectId(), s3Key: "k", fileName: "f", extension: "docx", contentType: "c", storageRevision: 4, reason: "forcesave" }
          : null,
      },
    } as never;
  }

  it("fresh when the current version sha matches", async () => {
    const doc = briefDoc();
    const state = await getBriefState(ctxFor(doc, doc.versionSha256));
    expect(state?.stale).toBe(false);
  });

  it("stale when the document has a newer committed version", async () => {
    const doc = briefDoc();
    const state = await getBriefState(ctxFor(doc, "b".repeat(64)));
    expect(state?.stale).toBe(true);
  });

  it("stale when the prompt version moved on", async () => {
    const doc = briefDoc({
      model: { provider: "gemini", providerModel: "m", promptVersion: "dora-brief-p0" },
    });
    const state = await getBriefState(ctxFor(doc, doc.versionSha256));
    expect(state?.stale).toBe(true);
  });
});
