import { describe, expect, it } from "vitest";

import {
  type LegacyTenderRow,
  dedupeReferences,
  noticeUiUrl,
  noticeXmlUrl,
  procedureCanonicalKey,
  toTenderReference,
} from "./tenders.ts";

function row(overrides: Partial<LegacyTenderRow> = {}): LegacyTenderRow {
  return {
    id: "legacy-1",
    notice_id: "9f4ecd3c-a807-4fdf-92e6-5603df329929",
    contract_folder_id: "1A39BE3F-66BC-47F9-A28E-3266E81DC125",
    publication_date: "2026-01-15",
    xml_url: null,
    ...overrides,
  };
}

describe("noticeXmlUrl", () => {
  it("builds the per-notice endpoint for both id shapes in the legacy data", () => {
    expect(noticeXmlUrl("9f4ecd3c-a807-4fdf-92e6-5603df329929")).toBe(
      "https://oeffentlichevergabe.de/api/notices/9f4ecd3c-a807-4fdf-92e6-5603df329929",
    );
    // 126 of the 505 referenced notices use a numeric id; the same route serves them.
    expect(noticeXmlUrl("24941244")).toBe(
      "https://oeffentlichevergabe.de/api/notices/24941244",
    );
  });

  it("escapes anything unexpected rather than building a broken URL", () => {
    expect(noticeXmlUrl("a b/c")).toBe(
      "https://oeffentlichevergabe.de/api/notices/a%20b%2Fc",
    );
  });
});

describe("noticeUiUrl", () => {
  it("is the human notice page, not the XML endpoint we fetch from", () => {
    // This value lands in sourceLinks and is what a user clicks; pointing it at
    // /api/notices would serve them raw XML.
    expect(noticeUiUrl("9f4ecd3c-a807-4fdf-92e6-5603df329929")).toBe(
      "https://oeffentlichevergabe.de/ui/de/bekanntmachung/9f4ecd3c-a807-4fdf-92e6-5603df329929",
    );
    expect(noticeUiUrl("24941244")).not.toContain("/api/");
  });
});

describe("procedureCanonicalKey", () => {
  it("lowercases, because the projection stores the key lowercased", () => {
    expect(procedureCanonicalKey("1A39BE3F-66BC-47F9-A28E-3266E81DC125")).toBe(
      "proc:1a39be3f-66bc-47f9-a28e-3266e81dc125",
    );
  });
});

describe("toTenderReference", () => {
  it("maps a legacy row onto the identifiers the new corpus indexes", () => {
    expect(toTenderReference(row())).toEqual({
      legacyTenderId: "legacy-1",
      sourceNoticeId: "9f4ecd3c-a807-4fdf-92e6-5603df329929",
      procedureId: "1A39BE3F-66BC-47F9-A28E-3266E81DC125",
      publishedAt: new Date("2026-01-15"),
      fallbackXmlUrl: null,
    });
  });

  it("keeps the legacy XML mirror when the row has one", () => {
    const reference = toTenderReference(
      row({ xml_url: "https://storage.googleapis.com/tender-xml/tenders/x.xml" }),
    );
    expect(reference?.fallbackXmlUrl).toBe(
      "https://storage.googleapis.com/tender-xml/tenders/x.xml",
    );
  });

  it("refuses a row with no notice id — there is nothing to fetch", () => {
    expect(toTenderReference(row({ notice_id: null }))).toBeNull();
    expect(toTenderReference(row({ notice_id: "  " }))).toBeNull();
  });

  it("drops an unparsable publication date instead of storing Invalid Date", () => {
    expect(toTenderReference(row({ publication_date: "not-a-date" }))?.publishedAt).toBeNull();
  });
});

describe("dedupeReferences", () => {
  it("collapses a notice several companies saved independently", () => {
    const references = [
      toTenderReference(row({ id: "a" }))!,
      toTenderReference(row({ id: "b" }))!,
    ];
    expect(dedupeReferences(references)).toHaveLength(1);
  });

  it("keeps the copy that carries a procedure id", () => {
    // The procedure id gives canonicalKey a second way to match an existing
    // tender, so a row that has one is strictly more useful.
    const deduped = dedupeReferences([
      toTenderReference(row({ id: "a", contract_folder_id: null }))!,
      toTenderReference(row({ id: "b" }))!,
    ]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0].legacyTenderId).toBe("b");
    expect(deduped[0].procedureId).not.toBeNull();
  });
});
