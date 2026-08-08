import { createHash } from "node:crypto";

import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end retrieval test against the real local stack: atlas-local Mongo
 * (search indexes must exist — run `npm run ai:bootstrap`) and the real
 * Gemini embedding API. Opt-in:
 *
 *   AI_INTEGRATION=1 npm run test
 */
const enabled = process.env.AI_INTEGRATION === "1";

const FIXTURES = [
  {
    key: "deadline",
    section: ["1. Fristen"],
    text: "Die Angebotsfrist endet am 27.08.2026 um 10:00 Uhr. Verspätete Angebote werden nicht berücksichtigt.",
  },
  {
    key: "insurance",
    section: ["3. Eignung", "3.1 Versicherungen"],
    text: "Der Bieter hat eine Betriebshaftpflichtversicherung mit einer Deckungssumme von mindestens 5 Mio. EUR für Personenschäden nachzuweisen.",
  },
  {
    key: "vob13",
    section: ["4. Vertragsbedingungen"],
    text: "Für die Mängelansprüche gilt § 13 VOB/B mit einer Verjährungsfrist von vier Jahren für Bauwerke.",
  },
  {
    key: "references",
    section: ["3. Eignung", "3.2 Referenzen"],
    text: "Es sind mindestens drei vergleichbare Referenzen über abgeschlossene Bauleistungen der letzten fünf Jahre einzureichen.",
  },
  {
    key: "penalties",
    section: ["4. Vertragsbedingungen"],
    text: "Bei Überschreitung der Vertragsfristen wird eine Vertragsstrafe von 0,2 % der Auftragssumme je Werktag fällig, höchstens jedoch 5 %.",
  },
  {
    key: "site",
    section: ["2. Baubeschreibung"],
    text: "Der Neubau der Kindertagesstätte umfasst sechs Gruppenräume, eine Mensa sowie Außenanlagen mit Spielgeräten.",
  },
];

describe.skipIf(!enabled)("hybridRetrieveChunks (integration)", () => {
  const tenderId = new ObjectId();
  const documentRecordId = `test:${tenderId}#integration`;
  const fileSha = createHash("sha256").update(documentRecordId).digest("hex");

  beforeAll(async () => {
    const { getAiCollections } = await import("../db/collections.ts");
    const { getGateway } = await import("../gateway/index.ts");
    const { extractLegalRefs } = await import("../chunking/legal-refs.ts");
    const { chunks } = await getAiCollections();

    const embedTexts = FIXTURES.map((f) => `${f.section.join(" > ")}\n${f.text}`);
    const embedded = await getGateway().embed({
      texts: embedTexts,
      taskType: "RETRIEVAL_DOCUMENT",
    });

    const now = new Date();
    await chunks.insertMany(
      FIXTURES.map((fixture, index) => ({
        tenantId: null,
        tenderId,
        documentRecordId,
        fileSha256: fileSha,
        fileName: "integration-fixture.pdf",
        mimeType: "application/pdf",
        docClass: null,
        language: "de",
        sectionPath: fixture.section,
        chunkIndex: index,
        text: fixture.text,
        legalRefs: extractLegalRefs(fixture.text),
        anchor: { page: null, paragraph: null, bbox: null, charStart: 0, charEnd: fixture.text.length },
        tokenCount: Math.ceil(fixture.text.length / 4),
        chunkerVersion: "integration",
        embedding: embedded.vectors[index],
        embeddingModel: embedded.model,
        embeddingVersion: embedded.version,
        embeddingDimensions: embedded.dimensions,
        sourceHash: createHash("sha256").update(embedTexts[index]).digest("hex"),
        createdAt: now,
      })) as never[],
    );

    // mongot indexes new documents asynchronously — poll both arms until
    // every fixture is visible instead of guessing a sleep.
    const { vectorSearchChunks } = await import("./vector.ts");
    const { keywordSearchChunks } = await import("./keyword.ts");
    const deadline = Date.now() + 90_000;
    for (;;) {
      const [vector, keyword] = await Promise.all([
        vectorSearchChunks("Bauleistung Angebot", { tenantId: null, tenderId }, 20),
        keywordSearchChunks("Angebotsfrist Versicherung Referenzen Vertragsstrafe Kindertagesstätte VOB", { tenantId: null, tenderId }, 20),
      ]);
      if (vector.length >= FIXTURES.length && keyword.length >= FIXTURES.length - 1) break;
      if (Date.now() > deadline) {
        throw new Error(
          `search indexes did not sync: vector=${vector.length} keyword=${keyword.length}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }, 150_000);

  afterAll(async () => {
    const { getAiCollections } = await import("../db/collections.ts");
    const { chunks } = await getAiCollections();
    await chunks.deleteMany({ tenderId });
    const { closeIngestionClient } = await import("../../ingestion/db/client.ts");
    await closeIngestionClient();
  });

  async function retrieve(text: string, mode: "keyword" | "vector" | "hybrid") {
    const { hybridRetrieveChunks } = await import("./hybrid.ts");
    return hybridRetrieveChunks({
      text,
      mode,
      k: 3,
      filters: { tenantId: null, tenderId },
    });
  }

  it("keyword mode finds the deadline clause", async () => {
    const results = await retrieve("Wann endet die Angebotsfrist?", "keyword");
    expect(results.length).toBeGreaterThan(0);
    expect(results.slice(0, 3).some((c) => c.text.includes("Angebotsfrist"))).toBe(true);
  }, 60_000);

  it("vector mode finds the insurance clause from an English query", async () => {
    const results = await retrieve("What insurance coverage is required?", "vector");
    expect(results.length).toBeGreaterThan(0);
    // Assert over the texts so a failure shows what WAS retrieved. Case-
    // insensitive: the compound "Betriebshaftpflichtversicherung" lowercases
    // the inner word.
    const topTexts = results.slice(0, 3).map((c) => c.text);
    expect(topTexts.join(" ## ")).toMatch(/haftpflichtversicherung/i);
  }, 60_000);

  it("hybrid mode ranks the § 13 VOB/B clause first for the legal-ref query", async () => {
    const results = await retrieve("Was gilt nach § 13 VOB/B?", "hybrid");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].legalRefs).toContain("§ 13 VOB/B");
  }, 60_000);

  it("returns nothing for a foreign tenderId", async () => {
    const { hybridRetrieveChunks } = await import("./hybrid.ts");
    const results = await hybridRetrieveChunks({
      text: "Angebotsfrist",
      mode: "hybrid",
      k: 5,
      filters: { tenantId: null, tenderId: new ObjectId() },
    });
    expect(results).toEqual([]);
  }, 60_000);
});
