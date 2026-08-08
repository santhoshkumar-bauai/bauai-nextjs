import { describe, expect, it } from "vitest";

import { chunkText, type RawChunk } from "./chunker.ts";

const OPTS = { targetTokens: 100, maxTokens: 300 };

const GERMAN_DOC = [
  "1. Allgemeine Bestimmungen",
  "",
  "Das Vergabeverfahren erfolgt nach der Vergabe- und Vertragsordnung für Bauleistungen. Angebote sind in deutscher Sprache abzufassen.",
  "",
  "1.1 Fristen",
  "",
  "Die Angebotsfrist endet am 27.08.2026 um 10:00 Uhr. Verspätete Angebote werden gemäß § 13 VOB/A ausgeschlossen.",
  "",
  "2. Eignungsnachweise",
  "",
  "Der Bieter hat mindestens drei vergleichbare Referenzen der letzten fünf Jahre nachzuweisen. Die Nachweise sind gemäß § 6a VOB/A mit dem Angebot einzureichen.",
].join("\n");

function assertOffsetsRoundTrip(source: string, chunks: RawChunk[]): void {
  for (const chunk of chunks) {
    const slice = source.slice(chunk.charStart, chunk.charEnd);
    // The chunk text may carry a prepended overlap sentence; the raw span
    // must appear verbatim at the end of the chunk text.
    expect(chunk.text.endsWith(slice)).toBe(true);
    expect(slice.trim().length).toBeGreaterThan(0);
  }
}

describe("chunkText", () => {
  it("round-trips character offsets against the source", () => {
    const chunks = chunkText(GERMAN_DOC, OPTS);
    expect(chunks.length).toBeGreaterThan(0);
    assertOffsetsRoundTrip(GERMAN_DOC, chunks);
  });

  it("tracks the section path from numbered headings", () => {
    const chunks = chunkText(GERMAN_DOC, OPTS);
    const fristenChunk = chunks.find((c) => c.text.includes("Angebotsfrist"));
    expect(fristenChunk?.sectionPath).toEqual([
      "1. Allgemeine Bestimmungen",
      "1.1 Fristen",
    ]);
    const eignungChunk = chunks.find((c) => c.text.includes("Referenzen"));
    expect(eignungChunk?.sectionPath).toEqual(["2. Eignungsnachweise"]);
  });

  it("extracts legal references per chunk", () => {
    const chunks = chunkText(GERMAN_DOC, OPTS);
    const fristenChunk = chunks.find((c) => c.text.includes("Angebotsfrist"));
    expect(fristenChunk?.legalRefs).toContain("§ 13 VOB/A");
  });

  it("enforces the hard token cap on oversized blocks", () => {
    const oversized = "Ein sehr langer Satz ohne Absatz. ".repeat(200);
    const chunks = chunkText(oversized, OPTS);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(OPTS.maxTokens + 80);
    }
    assertOffsetsRoundTrip(oversized, chunks);
  });

  it("adds a one-sentence overlap from the previous chunk", () => {
    const paragraphs = Array.from(
      { length: 6 },
      (_, i) =>
        `Absatz ${i + 1} behandelt die Anforderungen an die technische Leistungsfähigkeit des Bieters im Detail. Es gelten besondere Regeln.`,
    ).join("\n\n");
    const chunks = chunkText(paragraphs, { targetTokens: 40, maxTokens: 300 });
    expect(chunks.length).toBeGreaterThan(1);
    // The second chunk begins with the closing sentence of the first.
    expect(chunks[1].text.startsWith("Es gelten besondere Regeln.")).toBe(true);
    // But its offsets exclude that overlap.
    assertOffsetsRoundTrip(paragraphs, chunks);
  });

  it("handles umlauts and the section sign without offset drift", () => {
    const text = "Präqualifikation äöü ß.\n\nGemäß § 13 VOB/B gilt: Übergabe erfolgt fristgerecht.";
    const chunks = chunkText(text, OPTS);
    assertOffsetsRoundTrip(text, chunks);
  });

  it("returns nothing for empty input", () => {
    expect(chunkText("", OPTS)).toEqual([]);
    expect(chunkText("\n\n\n", OPTS)).toEqual([]);
  });

  it("assigns sequential chunk indexes", () => {
    const chunks = chunkText(GERMAN_DOC, { targetTokens: 30, maxTokens: 300 });
    expect(chunks.map((c) => c.chunkIndex)).toEqual(
      chunks.map((_, i) => i),
    );
  });
});
