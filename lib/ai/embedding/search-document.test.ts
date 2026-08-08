import { Decimal128, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";

import type { TenderDocument } from "../../ingestion/types.ts";
import { buildSearchDocument } from "./search-document.ts";

function fixtureTender(overrides: Partial<TenderDocument> = {}): TenderDocument {
  return {
    _id: new ObjectId(),
    canonicalKey: "proc:test",
    status: "OPEN",
    businessCategory: "TENDER",
    isVisible: true,
    title: "Verlängerung VMware Lizenzen 2026-2029",
    description: "Beschaffung von VMware Lizenzverlängerungen für das Rechenzentrum.",
    language: "de",
    buyer: {
      name: "Stadt Stuttgart",
      identifiers: [],
      email: null,
      phone: null,
      website: null,
      legalType: null,
      activityType: null,
      address: {
        street: null,
        city: "Stuttgart",
        postalCode: "70173",
        countryCode: "DE",
        nutsCodes: ["DE11"],
      } as never,
    },
    lots: [],
    cpvCodes: ["48218000"],
    countries: ["DE"],
    regions: ["DE11"],
    estimatedValue: { amount: Decimal128.fromString("250000"), currency: "EUR" },
    procedureType: "open",
    contractNature: "supplies",
    publicationDate: new Date("2026-07-01"),
    submissionDeadline: new Date("2026-08-27T08:00:00Z"),
    documents: [],
    currentNoticeId: new ObjectId(),
    currentVersionKey: "v1",
    noticeRefs: [],
    sourceLinks: [],
    relatedNoticeIds: [],
    dataQuality: { score: 1, warnings: [] },
    enrichment: {
      geocoding: { status: "PENDING" },
      translation: { status: "PENDING" },
      embedding: { status: "PENDING" },
    },
    aggregateVersion: 1,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as TenderDocument;
}

describe("buildSearchDocument", () => {
  it("produces the curated line format, not JSON", () => {
    const built = buildSearchDocument(fixtureTender());
    expect(built.text).toContain("Title: Verlängerung VMware Lizenzen");
    expect(built.text).toContain("Buyer: Stadt Stuttgart, Stuttgart");
    expect(built.text).toContain("CPV: 48218000");
    expect(built.text).toContain("Deadline: 2026-08-27");
    expect(built.text).not.toContain("_id");
    expect(built.text).not.toContain("aggregateVersion");
  });

  it("converts Decimal128 estimated value to a number filter", () => {
    const built = buildSearchDocument(fixtureTender());
    expect(built.filters.estimatedValueAmount).toBe(250000);
    expect(built.text).toContain("Estimated value: 250000 EUR");
  });

  it("omits missing fields instead of printing placeholders", () => {
    const built = buildSearchDocument(
      fixtureTender({
        title: null,
        description: null,
        buyer: null,
        estimatedValue: null,
        submissionDeadline: null,
      }),
    );
    expect(built.text).not.toContain("Title:");
    expect(built.text).not.toContain("Buyer:");
    expect(built.text).not.toContain("null");
  });

  it("truncates very long descriptions", () => {
    const built = buildSearchDocument(
      fixtureTender({ description: "x".repeat(10_000) }),
    );
    expect(built.text.length).toBeLessThan(6000);
    expect(built.text).toContain("…");
  });

  it("caps lots and notes the omission", () => {
    const lots = Array.from({ length: 15 }, (_, i) => ({
      lotId: `lot-${i}`,
      title: `Los ${i + 1}`,
      description: null,
      cpvCodes: [],
      estimatedValue: null,
      submissionDeadline: null,
      deadlineKind: "NONE" as const,
      contractNature: null,
      locations: [],
    }));
    const built = buildSearchDocument(fixtureTender({ lots }));
    expect(built.text).toContain("Lot 10: Los 10");
    expect(built.text).not.toContain("Lot 11:");
    expect(built.text).toContain("5 further lots omitted");
  });

  it("hash changes when content changes, stable when it does not", () => {
    const a = buildSearchDocument(fixtureTender());
    const b = buildSearchDocument(fixtureTender());
    const c = buildSearchDocument(fixtureTender({ title: "Anders" }));
    expect(a.sourceHash).toBe(b.sourceHash);
    expect(a.sourceHash).not.toBe(c.sourceHash);
  });
});
