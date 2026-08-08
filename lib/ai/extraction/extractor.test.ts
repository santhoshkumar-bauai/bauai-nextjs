import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SourceChunk } from "./citations.ts";
import type { RawExtractionResult } from "./engine.ts";

vi.mock("./engine.ts", () => ({
  extractViaRetrieval: vi.fn(),
  extractFromDocuments: vi.fn(),
  callModel: vi.fn(),
}));

const engine = await import("./engine.ts");
const { extractSchemaForTender } = await import("./extractor.ts");

const CHUNK_TEXT = "Die Angebotsfrist endet am 27.08.2026 um 10:00 Uhr.";

function fixtureChunk(): SourceChunk {
  return {
    chunkId: "C1",
    documentRecordId: "proc:x#rec",
    fileSha256: "a".repeat(64),
    text: CHUNK_TEXT,
    sectionPath: ["1. Fristen"],
    anchor: { charStart: 0, charEnd: CHUNK_TEXT.length },
  };
}

function rawResult(
  fields: RawExtractionResult["fields"],
): RawExtractionResult {
  return {
    path: "retrieval",
    documentRecordId: null,
    fields,
    unresolved: [],
    chunksById: new Map([["C1", fixtureChunk()]]),
    documentText: null,
    blocks: [
      { kind: "chunk", chunkId: "C1", sectionPath: ["1. Fristen"], text: CHUNK_TEXT },
    ],
    modelCalls: 1,
  };
}

const goodCitation = { chunkId: "C1", quote: "Angebotsfrist endet am 27.08.2026" };
const badCitation = { chunkId: "C1", quote: "dieser Satz existiert nicht" };

const tenderId = new ObjectId();
const gateway = {} as never;

beforeEach(() => {
  vi.mocked(engine.extractFromDocuments).mockResolvedValue([]);
  vi.mocked(engine.callModel).mockReset();
});

describe("extractSchemaForTender", () => {
  it("verifies clean results without retries", async () => {
    vi.mocked(engine.extractViaRetrieval).mockResolvedValue(
      rawResult({
        submissionDeadline: {
          value: "2026-08-27T10:00:00+02:00",
          confidence: 0.95,
          citations: [goodCitation],
        },
      }),
    );

    const outcome = await extractSchemaForTender({
      tenderId,
      schemaName: "deadlines",
      gateway,
    });

    expect(outcome.status).toBe("VERIFIED");
    expect(outcome.fields.submissionDeadline.citationState).toBe("VERIFIED");
    expect(engine.callModel).not.toHaveBeenCalled();
    expect(outcome.stats.retriedFields).toBe(0);
  });

  it("retries a failed citation once and accepts the corrected quote", async () => {
    vi.mocked(engine.extractViaRetrieval).mockResolvedValue(
      rawResult({
        submissionDeadline: {
          value: "2026-08-27",
          confidence: 0.9,
          citations: [badCitation],
        },
      }),
    );
    vi.mocked(engine.callModel).mockResolvedValueOnce({
      fields: {
        submissionDeadline: {
          value: "2026-08-27",
          confidence: 0.9,
          citations: [goodCitation],
        },
      },
      unresolved: [],
    });

    const outcome = await extractSchemaForTender({
      tenderId,
      schemaName: "deadlines",
      gateway,
    });

    expect(outcome.fields.submissionDeadline.citationState).toBe("VERIFIED");
    expect(engine.callModel).toHaveBeenCalledTimes(1);
    expect(outcome.stats.retriedFields).toBe(1);
    expect(outcome.status).toBe("VERIFIED");
  });

  it("gives up after two retries and keeps the field UNVERIFIED", async () => {
    vi.mocked(engine.extractViaRetrieval).mockResolvedValue(
      rawResult({
        submissionDeadline: {
          value: "2026-08-27",
          confidence: 0.9,
          citations: [badCitation],
        },
      }),
    );
    vi.mocked(engine.callModel).mockResolvedValue({
      fields: {
        submissionDeadline: {
          value: "2026-08-27",
          confidence: 0.9,
          citations: [badCitation],
        },
      },
      unresolved: [],
    });

    const outcome = await extractSchemaForTender({
      tenderId,
      schemaName: "deadlines",
      gateway,
    });

    expect(engine.callModel).toHaveBeenCalledTimes(2);
    expect(outcome.fields.submissionDeadline.citationState).toBe("UNVERIFIED");
    expect(outcome.status).toBe("PARTIAL");
  });

  it("returns EMPTY when no sources exist at all", async () => {
    vi.mocked(engine.extractViaRetrieval).mockResolvedValue(null);

    const outcome = await extractSchemaForTender({
      tenderId,
      schemaName: "deadlines",
      gateway,
    });

    expect(outcome.status).toBe("EMPTY");
    expect(outcome.unresolved.length).toBeGreaterThan(0);
    expect(outcome.stats.modelCalls).toBe(0);
  });
});
