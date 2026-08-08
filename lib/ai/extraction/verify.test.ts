import { describe, expect, it } from "vitest";

import type { SourceChunk } from "./citations.ts";
import { verifyCitation, verifyFields, type VerificationSources } from "./verify.ts";

const DOC_TEXT =
  "1. Fristen\n\nDie Angebotsfrist endet am 27.08.2026 um 10:00 Uhr.\n\n" +
  "2. Vertragsstrafen\n\nBei Verzug wird eine Vertragsstrafe von 0,2 % je Werktag fällig.";

function chunk(id: string, start: number, end: number): SourceChunk {
  return {
    chunkId: id,
    documentRecordId: "proc:x#rec",
    fileSha256: "f".repeat(64),
    text: DOC_TEXT.slice(start, end),
    sectionPath: [],
    anchor: { charStart: start, charEnd: end },
  };
}

const chunkA = chunk("A", 0, 62); // covers section 1
const chunkB = chunk("B", 64, DOC_TEXT.length); // covers section 2

function chunkSources(): VerificationSources {
  return {
    chunksById: new Map([
      ["A", chunkA],
      ["B", chunkB],
    ]),
    documentText: null,
    documentRecordId: null,
    documentFileSha256: null,
  };
}

function docSources(): VerificationSources {
  return {
    chunksById: new Map([
      ["A", chunkA],
      ["B", chunkB],
    ]),
    documentText: DOC_TEXT,
    documentRecordId: "proc:x#rec",
    documentFileSha256: "f".repeat(64),
  };
}

describe("verifyCitation — chunk path", () => {
  it("verifies an exact quote and stamps document identity + chunk anchor", () => {
    const { ok, stored } = verifyCitation(
      { chunkId: "A", quote: "Die Angebotsfrist endet am 27.08.2026" },
      chunkSources(),
    );
    expect(ok).toBe(true);
    expect(stored.documentRecordId).toBe("proc:x#rec");
    expect(stored.anchor.charStart).toBe(0);
    expect(stored.anchor.charEnd).toBe(62);
    expect(stored.quoteHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("tolerates whitespace differences", () => {
    const { ok } = verifyCitation(
      { chunkId: "A", quote: "Die  Angebotsfrist\nendet am 27.08.2026" },
      chunkSources(),
    );
    expect(ok).toBe(true);
  });

  it("fails a quote not present in the cited chunk", () => {
    const { ok } = verifyCitation(
      { chunkId: "A", quote: "Vertragsstrafe von 0,2 %" },
      chunkSources(),
    );
    expect(ok).toBe(false);
  });

  it("fails an unknown chunk id", () => {
    const { ok } = verifyCitation(
      { chunkId: "nope", quote: "Die Angebotsfrist" },
      chunkSources(),
    );
    expect(ok).toBe(false);
  });

  it("fails an empty quote", () => {
    expect(verifyCitation({ chunkId: "A", quote: "   " }, chunkSources()).ok).toBe(false);
  });
});

describe("verifyCitation — document path", () => {
  it("verifies against the document and resolves the enclosing chunk", () => {
    const { ok, stored } = verifyCitation(
      { chunkId: null, quote: "Vertragsstrafe von 0,2 % je Werktag" },
      docSources(),
    );
    expect(ok).toBe(true);
    expect(stored.chunkId).toBe("B");
    expect(stored.anchor.charStart).toBe(64);
  });

  it("keeps exact offsets when no chunk encloses the quote", () => {
    const sources = docSources();
    sources.chunksById = new Map(); // no chunks known
    const { ok, stored } = verifyCitation(
      { chunkId: null, quote: "Vertragsstrafe von 0,2 %" },
      sources,
    );
    expect(ok).toBe(true);
    expect(stored.chunkId).toBeNull();
    expect(stored.anchor.charStart).toBeGreaterThan(0);
  });

  it("fails quotes absent from the document", () => {
    const { ok } = verifyCitation(
      { chunkId: null, quote: "Dieser Satz existiert nicht." },
      docSources(),
    );
    expect(ok).toBe(false);
  });

  it("handles regex metacharacters in quotes", () => {
    const { ok } = verifyCitation(
      { chunkId: null, quote: "Vertragsstrafe von 0,2 % je Werktag fällig." },
      docSources(),
    );
    expect(ok).toBe(true);
  });
});

describe("verifyFields", () => {
  it("maps values to VERIFIED / UNVERIFIED / MISSING", () => {
    const { fields, failedFieldNames } = verifyFields(
      {
        good: {
          value: "2026-08-27",
          confidence: 0.9,
          citations: [{ chunkId: "A", quote: "Angebotsfrist endet am 27.08.2026" }],
        },
        bad: {
          value: 5,
          confidence: 0.8,
          citations: [{ chunkId: "A", quote: "nicht vorhanden" }],
        },
        noCitations: { value: true, confidence: 0.7, citations: [] },
        absent: null,
      },
      chunkSources(),
    );
    expect(fields.good.citationState).toBe("VERIFIED");
    expect(fields.bad.citationState).toBe("UNVERIFIED");
    expect(fields.noCitations.citationState).toBe("UNVERIFIED");
    expect(fields.absent.citationState).toBe("MISSING");
    expect(failedFieldNames.sort()).toEqual(["bad", "noCitations"]);
  });

  it("keeps failed citations for review visibility", () => {
    const { fields } = verifyFields(
      {
        mixed: {
          value: "x",
          confidence: 0.9,
          citations: [
            { chunkId: "A", quote: "Angebotsfrist" },
            { chunkId: "A", quote: "gibt es nicht" },
          ],
        },
      },
      chunkSources(),
    );
    expect(fields.mixed.citationState).toBe("VERIFIED");
    expect(fields.mixed.citations).toHaveLength(2);
  });
});
