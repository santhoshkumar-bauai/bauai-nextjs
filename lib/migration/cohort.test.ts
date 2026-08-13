import { describe, expect, it } from "vitest";

import {
  type ActivityCounts,
  type CohortEntry,
  type MemberCounts,
  type SourceCompany,
  activityTotal,
  buildCohort,
  cleanCompanyName,
  decodeHtmlEntities,
  looksLikeDomainName,
  looksLikeFreemailName,
  looksLikeTestName,
  mergeKey,
  proposeMerges,
} from "./cohort.ts";

const noActivity: ActivityCounts = {
  savedTenders: 0, dislikedTenders: 0, workspaceTenders: 0,
  chatSessions: 0, documents: 0, savedFilters: 0, extractedDocuments: 0,
};

function activity(overrides: Partial<ActivityCounts>): ActivityCounts {
  return { ...noActivity, ...overrides };
}

function membership(overrides: Partial<MemberCounts> = {}): MemberCounts {
  return { members: 1, signedIn: 1, recentlyActive: 1, onboarded: 1, ...overrides };
}

function company(id: string, name: string | null): SourceCompany {
  return {
    id,
    name,
    domain: null,
    company_domain: null,
    website: null,
    company_website: null,
    created_at: "2026-01-01",
  };
}

describe("decodeHtmlEntities", () => {
  it("decodes the numeric entities scraped from Impressum page titles", () => {
    // Verbatim from production: companies.name in mvp1-bauai.
    expect(decodeHtmlEntities("Impressum &#038; Datenschutz &#8211; Hans")).toBe(
      "Impressum & Datenschutz – Hans",
    );
  });

  it("decodes named and hex entities, and leaves unknown ones alone", () => {
    expect(decodeHtmlEntities("Bau &amp; Co &#x2013; GmbH")).toBe("Bau & Co – GmbH");
    expect(decodeHtmlEntities("keep &notanentity; intact")).toBe(
      "keep &notanentity; intact",
    );
  });
});

describe("cleanCompanyName", () => {
  it("strips scraped boilerplate and the separator it leaves behind", () => {
    expect(cleanCompanyName("Impressum &#8211; HNS Bau GmbH")).toBe("HNS Bau GmbH");
    expect(cleanCompanyName("Impressum &#038; Datenschutz &#8211; Hansa Bau")).toBe(
      "Hansa Bau",
    );
  });

  it("collapses whitespace and handles null", () => {
    expect(cleanCompanyName("  WIRL   INGENIEURE  GMBH ")).toBe("WIRL INGENIEURE GMBH");
    expect(cleanCompanyName(null)).toBe("");
  });
});

describe("name classification", () => {
  it("recognises names that are really email domains", () => {
    expect(looksLikeDomainName("hns-bau-gmbh.de")).toBe(true);
    expect(looksLikeDomainName("newdigitalcraft.com")).toBe(true);
    expect(looksLikeDomainName("WIRL INGENIEURE GMBH")).toBe(false);
  });

  it("recognises consumer mail hosts", () => {
    expect(looksLikeFreemailName("yahoo.de")).toBe(true);
    expect(looksLikeFreemailName("proton.me")).toBe(true);
    expect(looksLikeFreemailName("hns-bau-gmbh.de")).toBe(false);
  });

  it("flags test and demo accounts without catching real firms", () => {
    expect(looksLikeTestName("architekttest.de")).toBe(true);
    expect(looksLikeTestName("Test Company")).toBe(true);
    expect(looksLikeTestName("anirban.com")).toBe(true);
    // Real German construction firms must survive this filter.
    expect(looksLikeTestName("CARBOCON GMBH")).toBe(false);
    expect(looksLikeTestName("Brueninghoff Group")).toBe(false);
    expect(looksLikeTestName("seg architekten PartGmbB")).toBe(false);
  });
});

describe("mergeKey", () => {
  it("collapses the duplicate WIRL rows onto one key", () => {
    expect(mergeKey("WIRL INGENIEURE GMBH")).toBe(mergeKey("Wirl Ingenieure GmbH"));
  });

  it("ignores a missing legal form", () => {
    expect(mergeKey("BAU AI GmbH")).toBe(mergeKey("BAU AI"));
  });

  it("matches a display name against its own email domain", () => {
    // The two HNS Bau rows: one scraped from the website, one from the domain.
    expect(mergeKey("Impressum &#8211; HNS Bau GmbH")).toBe(mergeKey("hns-bau-gmbh.de"));
  });

  it("strips a legal form that a domain ran together with the name", () => {
    // Production case: "lavettegruppe.com" and "Lavette GmbH" are one firm, but
    // the domain has no separator for the word filter to split on.
    expect(mergeKey("lavettegruppe.com")).toBe(mergeKey("Lavette GmbH"));
  });

  it("keeps genuinely different firms apart", () => {
    expect(mergeKey("Terras Holding GmbH")).not.toBe(mergeKey("Terravis Biogas GmbH"));
    // The suffix strip must not maul a real name that merely ends in one.
    expect(mergeKey("Montag Bau")).toBe("montagbau");
    expect(mergeKey("Hansa Bauteam")).not.toBe(mergeKey("Hansa Bauunternehmung GmbH"));
  });
});

describe("activityTotal", () => {
  it("excludes extracted documents so one analysis cannot dominate", () => {
    expect(activityTotal(activity({ savedTenders: 2, extractedDocuments: 1412 }))).toBe(2);
  });
});

describe("buildCohort", () => {
  const base = {
    profiles: [],
    activityByCompany: new Map<string, ActivityCounts>(),
    membershipByCompany: new Map<string, MemberCounts>(),
  };

  it("includes an active, clearly-named firm", () => {
    const report = buildCohort({
      ...base,
      companies: [company("c1", "CARBOCON GMBH")],
      activityByCompany: new Map([["c1", activity({ dislikedTenders: 58 })]]),
      membershipByCompany: new Map([["c1", membership()]]),
    });

    expect(report.entries[0].decision).toBe("include");
    expect(report.totals.include).toBe(1);
    expect(report.totals.usersInCohort).toBe(1);
  });

  it("excludes the signup fallback bucket on member count alone", () => {
    // "Test Company" absorbed 110 users; no real tenant looks like this.
    const report = buildCohort({
      ...base,
      companies: [company("c1", "Acme Bau GmbH")],
      activityByCompany: new Map([["c1", activity({ chatSessions: 4 })]]),
      membershipByCompany: new Map([["c1", membership({ members: 110 })]]),
    });

    expect(report.entries[0].decision).toBe("exclude");
    expect(report.entries[0].reason).toContain("fallback bucket");
  });

  it("excludes zero-activity shells and test accounts", () => {
    const report = buildCohort({
      ...base,
      companies: [company("c1", "Echte Bau GmbH"), company("c2", "architekttest.de")],
      activityByCompany: new Map([["c2", activity({ chatSessions: 6 })]]),
      membershipByCompany: new Map([
        ["c1", membership()],
        ["c2", membership()],
      ]),
    });

    const byId = new Map(report.entries.map((entry) => [entry.companyId, entry]));
    expect(byId.get("c1")?.reason).toBe("no activity");
    expect(byId.get("c2")?.reason).toBe("test/demo name pattern");
    expect(report.totals.include).toBe(0);
  });

  it("sends domain-named and freemail companies to human review, not the bin", () => {
    const report = buildCohort({
      ...base,
      companies: [company("c1", "hns-bau-gmbh.de"), company("c2", "yahoo.de")],
      activityByCompany: new Map([
        ["c1", activity({ workspaceTenders: 13 })],
        ["c2", activity({ workspaceTenders: 6 })],
      ]),
      membershipByCompany: new Map([
        ["c1", membership({ members: 2 })],
        ["c2", membership()],
      ]),
    });

    expect(report.entries.every((entry) => entry.decision === "review")).toBe(true);
    expect(report.totals.review).toBe(2);
    // Review companies are not counted as migrating users until signed off.
    expect(report.totals.usersInCohort).toBe(0);
  });

  it("starts unsigned so downstream phases refuse to run", () => {
    const report = buildCohort({ ...base, companies: [] });
    expect(report.signedOffBy).toBeNull();
  });
});

describe("overrides", () => {
  const base = {
    profiles: [],
    activityByCompany: new Map<string, ActivityCounts>(),
    membershipByCompany: new Map<string, MemberCounts>(),
  };

  it("lets a human drop a reviewed company by name", () => {
    const report = buildCohort({
      ...base,
      companies: [company("c1", "ro12121.eu")],
      activityByCompany: new Map([["c1", activity({ chatSessions: 7 })]]),
      membershipByCompany: new Map([["c1", membership()]]),
      overrides: {
        "ro12121.eu": {
          decision: "exclude",
          reason: "throwaway signup",
          by: "Santhosh",
        },
      },
    });

    expect(report.entries[0].decision).toBe("exclude");
    expect(report.entries[0].overriddenBy).toBe("Santhosh");
    expect(report.totals.review).toBe(0);
  });

  it("lets a human rescue a company the rules excluded, keyed by id", () => {
    const report = buildCohort({
      ...base,
      companies: [company("c1", "Echte Bau GmbH")],
      membershipByCompany: new Map([["c1", membership()]]),
      overrides: {
        c1: { decision: "include", reason: "known customer", by: "Rishi" },
      },
    });

    expect(report.entries[0].decision).toBe("include");
    expect(report.totals.usersInCohort).toBe(1);
  });

  it("warns instead of silently ignoring an override that matches nothing", () => {
    const report = buildCohort({
      ...base,
      companies: [company("c1", "CARBOCON GMBH")],
      activityByCompany: new Map([["c1", activity({ savedTenders: 3 })]]),
      membershipByCompany: new Map([["c1", membership()]]),
      overrides: {
        "carbcon gmbh": { decision: "exclude", reason: "typo", by: "Santhosh" },
      },
    });

    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain("matched no company");
    expect(report.entries[0].decision).toBe("include");
  });

  it("breaks up a merge when an override excludes the survivor", () => {
    const report = buildCohort({
      ...base,
      companies: [
        company("a", "WIRL INGENIEURE GMBH"),
        company("b", "Wirl Ingenieure GmbH"),
      ],
      activityByCompany: new Map([
        ["a", activity({ chatSessions: 404 })],
        ["b", activity({ chatSessions: 148 })],
      ]),
      membershipByCompany: new Map([
        ["a", membership()],
        ["b", membership()],
      ]),
      overrides: {
        a: { decision: "exclude", reason: "mistake", by: "Santhosh" },
      },
    });

    // The remaining company must not point at a survivor that is not migrating.
    expect(report.mergeProposals).toEqual([]);
    expect(report.entries.find((item) => item.companyId === "b")?.mergeInto).toBeUndefined();
    expect(report.warnings.some((text) => text.includes("no longer merges"))).toBe(true);
  });

  it("drops a merge entirely when both sides are excluded", () => {
    // Production case: bau.co and bau.eu were merged, then both excluded.
    const report = buildCohort({
      ...base,
      companies: [company("a", "bau.co"), company("b", "bau.eu")],
      activityByCompany: new Map([
        ["a", activity({ chatSessions: 2 })],
        ["b", activity({ chatSessions: 1 })],
      ]),
      membershipByCompany: new Map([
        ["a", membership()],
        ["b", membership()],
      ]),
      overrides: {
        "bau.co": { decision: "exclude", reason: "throwaway", by: "Santhosh" },
        "bau.eu": { decision: "exclude", reason: "throwaway", by: "Santhosh" },
      },
    });

    expect(report.mergeProposals).toEqual([]);
    expect(report.warnings).toEqual([]);
  });
});

describe("proposeMerges", () => {
  function entry(
    companyId: string,
    cleanedName: string,
    activityTotalValue: number,
    decision: CohortEntry["decision"] = "include",
  ): CohortEntry {
    return {
      companyId,
      name: cleanedName,
      cleanedName,
      domain: null,
      createdAt: null,
      decision,
      reason: "",
      activityTotal: activityTotalValue,
      activity: noActivity,
      membership: membership(),
    };
  }

  it("keeps the busiest row as the survivor", () => {
    const proposals = proposeMerges([
      entry("a", "Wirl Ingenieure GmbH", 211),
      entry("b", "WIRL INGENIEURE GMBH", 740),
    ]);

    expect(proposals).toHaveLength(1);
    expect(proposals[0].survivorId).toBe("b");
    expect(proposals[0].absorbedIds).toEqual(["a"]);
  });

  it("ignores excluded companies", () => {
    expect(
      proposeMerges([
        entry("a", "Wirl Ingenieure GmbH", 211, "exclude"),
        entry("b", "WIRL INGENIEURE GMBH", 740, "exclude"),
      ]),
    ).toEqual([]);
  });

  it("does not propose a merge for a unique name", () => {
    expect(proposeMerges([entry("a", "CARBOCON GMBH", 76)])).toEqual([]);
  });

  it("prefers a real company name over the survivor's email-domain name", () => {
    // Production case: the busiest HNS Bau row is named after its email domain,
    // while the quieter duplicate carries the name scraped from the website.
    const proposals = proposeMerges([
      entry("a", "hns-bau-gmbh.de", 15, "review"),
      entry("b", "HNS Bau GmbH", 2),
    ]);

    expect(proposals[0].survivorId).toBe("a");
    expect(proposals[0].preferredName).toBe("HNS Bau GmbH");
  });

  it("graduates a reviewed company once a duplicate identifies it", () => {
    const report = buildCohort({
      profiles: [],
      companies: [company("a", "hns-bau-gmbh.de"), company("b", "HNS Bau GmbH")],
      activityByCompany: new Map([
        ["a", activity({ workspaceTenders: 13 })],
        ["b", activity({ workspaceTenders: 2 })],
      ]),
      membershipByCompany: new Map([
        ["a", membership({ members: 2 })],
        ["b", membership()],
      ]),
    });

    expect(report.entries.every((item) => item.decision === "include")).toBe(true);
    expect(report.totals.review).toBe(0);
    // Both rows' users migrate, into the one surviving company.
    expect(report.totals.usersInCohort).toBe(3);
    expect(
      report.entries.find((item) => item.companyId === "a")?.reason,
    ).toContain("HNS Bau GmbH");
  });

  it("tags absorbed companies with their survivor in the report", () => {
    const report = buildCohort({
      profiles: [],
      companies: [
        company("a", "WIRL INGENIEURE GMBH"),
        company("b", "Wirl Ingenieure GmbH"),
      ],
      activityByCompany: new Map([
        ["a", activity({ chatSessions: 404 })],
        ["b", activity({ chatSessions: 148 })],
      ]),
      membershipByCompany: new Map([
        ["a", membership()],
        ["b", membership({ members: 2 })],
      ]),
    });

    const absorbed = report.entries.find((item) => item.companyId === "b");
    expect(absorbed?.mergeInto).toBe("a");
    expect(report.entries.find((item) => item.companyId === "a")?.mergeInto).toBeUndefined();
  });
});
