import { describe, expect, it } from "vitest";

import {
  buildProfileTerms,
  hasUsableTerms,
  MAX_TERMS,
  segmentCatalogName,
} from "@/lib/tenders/profile-terms";

/**
 * `buildProfileTerms` only touches the database when the profile carries CPV
 * codes, so every case here passes none and stays a pure unit test.
 */

describe("segmentCatalogName", () => {
  it("splits a catalog name on its conjunctions", () => {
    expect(segmentCatalogName("Dachdeckarbeiten und Klempnerarbeiten")).toEqual([
      "Dachdeckarbeiten",
      "Klempnerarbeiten",
    ]);
  });

  it("drops the dangling half of a German compound ellipsis", () => {
    // "Komplett-" stems onto "Komplettsanierung", which is how four heating
    // lots reached the top of a bridge builder's feed.
    const parts = segmentCatalogName(
      "Komplett- oder Teilbauleistungen im Hochbau sowie Tiefbauarbeiten",
    );
    expect(parts).not.toContain("Komplett-");
    expect(parts).toContain("Tiefbauarbeiten");
  });

  it("drops segments that are only filler", () => {
    expect(segmentCatalogName("zugehörige Arbeiten")).toEqual([]);
    expect(segmentCatalogName("Sonstige Dienstleistungen")).toEqual([]);
  });

  it("drops segments longer than the word cap", () => {
    expect(
      segmentCatalogName("Technische Planungsleistungen für die gesamte Anlage"),
    ).toEqual([]);
  });

  it("keeps a specific multi-word segment intact", () => {
    expect(segmentCatalogName("Installation von elektrischen Leitungen")).toEqual([
      "Installation von elektrischen Leitungen",
    ]);
  });
});

describe("buildProfileTerms", () => {
  it("ranks specializations above trades above services", async () => {
    const terms = await buildProfileTerms({
      services: ["Roofing"],
      trade: ["Dachdecker"],
      specializations: ["Dachabdichtung"],
    });
    expect(terms.map((term) => term.text)).toEqual([
      "Dachabdichtung",
      "Dachdecker",
      "Roofing",
    ]);
  });

  it("keeps the strongest weight when a term repeats across fields", async () => {
    const terms = await buildProfileTerms({
      services: ["Elektroinstallation"],
      specializations: ["elektroinstallation"],
    });
    expect(terms).toHaveLength(1);
    expect(terms[0].source).toBe("specialization");
  });

  it("segments an over-long free-text entry instead of dropping it", async () => {
    const terms = await buildProfileTerms({
      specializations: ["Planung und Bauüberwachung von Elektroanlagen"],
    });
    expect(terms.map((term) => term.text)).toContain(
      "Bauüberwachung von Elektroanlagen",
    );
  });

  it("drops fragments below the minimum length", async () => {
    const terms = await buildProfileTerms({ trade: ["ELT", "Bau"] });
    expect(terms).toEqual([]);
  });

  it("humanizes the business domain enum", async () => {
    const terms = await buildProfileTerms({ businessDomain: "CIVIL_ENGINEERING" });
    expect(terms[0].text).toBe("civil engineering");
  });

  it("caps the term count", async () => {
    const terms = await buildProfileTerms({
      specializations: Array.from({ length: 200 }, (_, i) => `Spezialgebiet${i}`),
    });
    expect(terms).toHaveLength(MAX_TERMS);
  });
});

describe("hasUsableTerms", () => {
  it("rejects a profile that yielded only a business domain", async () => {
    const terms = await buildProfileTerms({ businessDomain: "CONSTRUCTION" });
    expect(hasUsableTerms(terms)).toBe(false);
  });

  it("accepts a profile with a real capability", async () => {
    const terms = await buildProfileTerms({
      businessDomain: "CONSTRUCTION",
      trade: ["Dachdecker"],
    });
    expect(hasUsableTerms(terms)).toBe(true);
  });
});
