import { describe, expect, it } from "vitest";

import {
  type SourceCompanyRow,
  cleanBankDetails,
  cleanInsurances,
  cleanReferenceProjects,
  extractCpvCode,
  humanizeDomainName,
  mapBusinessDomain,
  mapKnowledgeBase,
  mergeSourceRows,
  parseJsonMaybe,
  resolveWebsite,
  resolveWebsiteFromRows,
  toCoordinates,
  toCompanyDocument,
  toCpvCodes,
  toProjectSizeRange,
  toStringArray,
} from "./companies.ts";

const TRIAL_START = new Date("2026-08-12T00:00:00.000Z");
const TRIAL_END = new Date("2026-09-11T00:00:00.000Z");

function map(row: SourceCompanyRow, name = "Test GmbH") {
  return toCompanyDocument({
    row,
    name,
    createdBy: "user-1",
    trialStartsAt: TRIAL_START,
    trialEndsAt: TRIAL_END,
  });
}

describe("parseJsonMaybe / toStringArray", () => {
  it("parses the JSON-encoded strings the legacy trade column holds", () => {
    // Verbatim shape from production.
    expect(toStringArray('["Hochbau","Construction"]')).toEqual([
      "Hochbau",
      "Construction",
    ]);
  });

  it("accepts a real array, deduplicates, and trims trailing CRLF", () => {
    expect(toStringArray(["Tiefbau", " Tiefbau ", "Rohbau\r\n"])).toEqual([
      "Tiefbau",
      "Rohbau",
    ]);
  });

  it("splits a delimited plain string and tolerates junk", () => {
    expect(toStringArray("Hochbau, Tiefbau")).toEqual(["Hochbau", "Tiefbau"]);
    expect(toStringArray(null)).toEqual([]);
    expect(toStringArray("{not json")).toEqual(["{not json"]);
  });

  it("leaves an unparsable JSON-looking string intact", () => {
    expect(parseJsonMaybe("{broken")).toBe("{broken");
  });
});

describe("CPV codes", () => {
  it("extracts the bare code from a code-plus-label entry", () => {
    // Ranking matches on code prefixes, so the label must not survive.
    expect(extractCpvCode("33697110-6 - Knochenzemente")).toBe("33697110-6");
    expect(extractCpvCode("45000000-7")).toBe("45000000-7");
  });

  it("reports entries whose code cannot be parsed instead of dropping them", () => {
    const result = toCpvCodes([
      "34946000-0 - Gleisbaumaterial und -teile",
      "Hochbau allgemein",
    ]);

    expect(result.codes).toEqual(["34946000-0"]);
    expect(result.unresolved).toEqual(["Hochbau allgemein"]);
  });

  it("treats a code missing its check digit as unresolved", () => {
    // A wrong check digit would silently mismatch the CPV catalog.
    expect(toCpvCodes(["45000000"]).codes).toEqual([]);
    expect(toCpvCodes(["45000000"]).unresolved).toEqual(["45000000"]);
  });
});

describe("mapBusinessDomain", () => {
  it("trusts company_domain first — it is the same enum onboarding uses", () => {
    // Set on 100% of the cohort, so nothing below should normally be reached.
    expect(mapBusinessDomain("CONSTRUCTION", null, [])).toEqual({
      domain: "CONSTRUCTION",
      inferred: false,
    });
    // An explicit OTHER is a user's choice, not a gap to be second-guessed.
    expect(mapBusinessDomain("OTHER", null, ["Reinigung"])).toEqual({
      domain: "OTHER",
      inferred: false,
    });
  });

  it("maps the legacy company_type values, ignoring trailing CRLF", () => {
    // Production literally stores "construction_firm\r\n".
    expect(mapBusinessDomain(null, "construction_firm\r\n", []).domain).toBe("CONSTRUCTION");
    expect(mapBusinessDomain("", "engineering_firm", []).domain).toBe("ENGINEERING");
    expect(mapBusinessDomain("", "architect_firm", []).domain).toBe("ARCHITECTURE");
  });

  it("infers from German trade terms when both columns are blank", () => {
    expect(mapBusinessDomain("", "", ["Tragwerksplanung", "Bauphysik"])).toEqual({
      domain: "ENGINEERING",
      inferred: true,
    });
    expect(mapBusinessDomain(null, null, ["Fliesenhandel"]).domain).toBe("MATERIAL_SUPPLIER");
    expect(mapBusinessDomain(null, null, ["Reinigung"]).domain).toBe("FACILITY_MANAGEMENT");
    expect(mapBusinessDomain(null, null, ["Hochbau", "Tiefbau"]).domain).toBe("CONSTRUCTION");
    expect(mapBusinessDomain(null, null, ["Metallbau"]).domain).toBe("HANDWERK");
  });

  it("prefers the more specific trade over a generic Bau match", () => {
    expect(mapBusinessDomain(null, null, ["Architekturbüro", "Hochbau"]).domain).toBe(
      "ARCHITECTURE",
    );
  });

  it("falls back to OTHER when nothing matches", () => {
    expect(mapBusinessDomain(null, null, ["Sonstiges"])).toEqual({
      domain: "OTHER",
      inferred: true,
    });
  });
});

describe("cleanBankDetails", () => {
  it("discards the all-null shell 29 of 37 companies carry", () => {
    expect(
      cleanBankDetails({
        bic: null, iban: null, bank_name: null,
        account_holder: null, account_number: null,
      }),
    ).toBeUndefined();
  });

  it("keeps real values and camelCases the keys", () => {
    expect(
      cleanBankDetails({ iban: "DE89 3704 ", bank_name: "Sparkasse", bic: null }),
    ).toEqual({ iban: "DE89 3704", bankName: "Sparkasse" });
  });
});

describe("cleanInsurances / cleanReferenceProjects", () => {
  it("drops the empty insurance row rather than violating a required field", () => {
    expect(cleanInsurances([{ type: "", amount: "", details: "" }])).toEqual([]);
  });

  it("keeps a populated insurance", () => {
    expect(cleanInsurances([{ type: "Haftpflicht", amount: "5 Mio", details: "" }])).toEqual([
      { type: "Haftpflicht", amount: "5 Mio" },
    ]);
  });

  it("drops blank reference projects but keeps real ones", () => {
    expect(
      cleanReferenceProjects([
        { year: "", title: "", value: "", client: "", description: "" },
        {
          year: "2021 - 2024",
          title: "Neubau von 120 WE",
          value: "20,3 Mio €",
          client: "MBP24 GmbH",
          description: "Kurzbeschreibung",
        },
      ]),
    ).toEqual([
      {
        title: "Neubau von 120 WE",
        description: "Kurzbeschreibung",
        client: "MBP24 GmbH",
        year: "2021 - 2024",
        value: "20,3 Mio €",
      },
    ]);
  });
});

describe("mapKnowledgeBase", () => {
  it("camelCases the legacy snake_case groups and fields", () => {
    const result = mapKnowledgeBase({
      contact_info: {
        email: "papenburg@johann-bunte.de",
        main_phone: "+49 4961 895-0",
        website: "https://www.johann-bunte.de/",
      },
      financial_info: { revenue_year1: "120", revenue_current: null },
    });

    expect(result.knowledgeBase).toEqual({
      contactInfo: {
        email: "papenburg@johann-bunte.de",
        mainPhone: "+49 4961 895-0",
        website: "https://www.johann-bunte.de/",
      },
      financialInfo: { revenueYear1: "120" },
    });
    expect(result.droppedGroups).toEqual([]);
  });

  it("reports unknown groups instead of writing them into a typed schema", () => {
    const result = mapKnowledgeBase({ mystery_group: { a: 1 } });
    expect(result.knowledgeBase).toBeUndefined();
    expect(result.droppedGroups).toEqual(["mystery_group"]);
  });
});

describe("coordinates and ranges", () => {
  it("reads the legacy lat/lng shape and rejects out-of-range values", () => {
    expect(toCoordinates({ lat: 48.1351253, lng: 11.5819806 })).toEqual({
      lat: 48.1351253,
      lng: 11.5819806,
    });
    expect(toCoordinates({ lat: 999, lng: 11 })).toBeUndefined();
    expect(toCoordinates(null)).toBeUndefined();
  });

  it("parses the JSON-encoded project size range", () => {
    expect(toProjectSizeRange('{"min":"300000","max":"3000000"}')).toEqual({
      min: "300000",
      max: "3000000",
    });
  });
});

describe("resolveWebsite", () => {
  it("keeps www in the URL but strips it from the domain, exactly as onboarding does", () => {
    expect(resolveWebsite({ id: "1", website: "www.brueninghoff.de" })).toEqual({
      website: "https://www.brueninghoff.de",
      domain: "brueninghoff.de",
    });
  });

  it("prefers company_website, then falls back to the domain column", () => {
    expect(
      resolveWebsite({ id: "1", company_website: "https://www.admi.de/", website: "" }),
    ).toEqual({ website: "https://www.admi.de", domain: "admi.de" });

    // "Company (chat.de)" has an empty website but a usable domain.
    expect(resolveWebsite({ id: "1", website: "", domain: "chat.de" })?.domain).toBe(
      "chat.de",
    );
  });

  it("skips a placeholder website and falls through to the real domain", () => {
    // koblenzer-wohnbau.de literally has website "example.org"; keying the
    // tenant on that would collide with every other row that did the same.
    expect(
      resolveWebsite({ id: "1", website: "example.org", domain: "koblenzer-wohnbau.de" }),
    ).toEqual({
      website: "https://koblenzer-wohnbau.de",
      domain: "koblenzer-wohnbau.de",
    });
  });

  it("never treats company_domain as a website — it holds the business enum", () => {
    expect(resolveWebsite({ id: "1", company_domain: "OTHER" })).toBeNull();
  });

  it("returns null when there is nothing to key on", () => {
    expect(resolveWebsite({ id: "1" })).toBeNull();
  });
});

describe("resolveWebsiteFromRows", () => {
  it("outvotes a column holding another company's domain", () => {
    // Production: WIRL's company_website is "spaceera.de" — a different firm —
    // while wirl-ing.de appears in four other fields across its two rows.
    const resolution = resolveWebsiteFromRows([
      {
        id: "a",
        domain: "wirl.net",
        website: "www.wirl-ing.de",
        company_website: "spaceera.de",
      },
      {
        id: "b",
        domain: "wirl-ing.de",
        website: "https://www.wirl-ing.de/",
        company_website: "https://www.wirl-ing.de/",
      },
    ]);

    expect(resolution.site?.domain).toBe("wirl-ing.de");
    expect(resolution.disagreement).toBe(true);
    expect(resolution.candidates[0]).toEqual({ domain: "wirl-ing.de", votes: 4 });
  });

  it("breaks a tie toward the domain column mvp1 grouped users by", () => {
    const resolution = resolveWebsiteFromRows([
      { id: "a", domain: "bmf-engineering.de", website: "https://fassaden-engineering.de/" },
    ]);

    expect(resolution.site?.domain).toBe("bmf-engineering.de");
    expect(resolution.disagreement).toBe(true);
  });

  it("ignores placeholder hosts entirely", () => {
    const resolution = resolveWebsiteFromRows([
      { id: "a", website: "example.org", domain: "koblenzer-wohnbau.de" },
    ]);

    expect(resolution.site?.domain).toBe("koblenzer-wohnbau.de");
    expect(resolution.candidates).toHaveLength(1);
    expect(resolution.disagreement).toBe(false);
  });

  it("returns nothing when no row has a usable address", () => {
    expect(resolveWebsiteFromRows([{ id: "a", company_domain: "OTHER" }]).site).toBeNull();
  });
});

describe("humanizeDomainName", () => {
  it("reads like a company name, matching how onboarding names a new tenant", () => {
    expect(humanizeDomainName("ib-burak.de")).toBe("Ib Burak");
    expect(humanizeDomainName("knapp-kubitza-architekten.de")).toBe(
      "Knapp Kubitza Architekten",
    );
  });
});

describe("toCompanyDocument", () => {
  const row: SourceCompanyRow = {
    id: "legacy-1",
    name: "Brueninghoff Group",
    domain: "brueninghoff.de",
    website: "www.brueninghoff.de",
    region: "Deutschland",
    company_type: "construction_firm\r\n",
    trade: '["Hochbau","Construction"]',
    cpv_codes: ["45000000-7 - Bauarbeiten"],
    address_coordinates: { lat: 51.9, lng: 7.6 },
    bank_details: { iban: null, bic: null },
    insurances: [{ type: "", amount: "" }],
    employee_count: "250",
  };

  it("produces a document the app can actually use", () => {
    const result = map(row, "Brueninghoff Group");
    const document = result.document!;

    expect(document.domain).toBe("brueninghoff.de");
    expect(document.website).toBe("https://www.brueninghoff.de");
    expect(document.businessDomain).toBe("CONSTRUCTION");
    expect(document.cpvCodes).toEqual(["45000000-7"]);
    expect(document.trade).toEqual(["Hochbau", "Construction"]);
    // services feeds the matching pipeline and has no other legacy source.
    expect(document.services).toEqual(["Hochbau", "Construction"]);
    expect(document.employeeCount).toBe(250);
    expect(document.addressCoordinates).toEqual({ lat: 51.9, lng: 7.6 });
    expect(document.bankDetails).toBeUndefined();
    expect(document.insurances).toEqual([]);
    // Phase 4 owns membership; Phase 3 must not invent it.
    expect(document.members).toEqual([]);
    expect(document.trial).toEqual({
      status: "active",
      startsAt: TRIAL_START,
      endsAt: TRIAL_END,
    });
  });

  it("refuses a row with no derivable unique key", () => {
    const result = map({ id: "legacy-2", name: "Nameless" });
    expect(result.document).toBeNull();
    expect(result.issues[0]).toContain("no usable website or domain");
  });

  it("defaults a missing region and says so", () => {
    const result = map({ id: "3", domain: "x.de", region: null });
    expect(result.document!.region).toBe("Deutschland");
    expect(result.issues.some((issue) => issue.includes("region missing"))).toBe(true);
  });

  it("flags a company with no services, since matching depends on them", () => {
    const result = map({ id: "4", domain: "x.de", trade: null });
    expect(result.document!.services).toEqual([]);
    expect(result.issues.some((issue) => issue.includes("no trade/services"))).toBe(true);
  });

  it("renames a company whose legacy name was just its email domain", () => {
    const result = map(
      { id: "5", domain: "ib-burak.de", company_domain: "ENGINEERING" },
      "ib-burak.de",
    );

    expect(result.document!.name).toBe("Ib Burak");
    expect(result.issues.some((issue) => issue.includes("renamed"))).toBe(true);
  });

  it("leaves a real company name alone", () => {
    const result = map(
      { id: "6", domain: "carbocon.de", company_domain: "CONSTRUCTION" },
      "CARBOCON GMBH",
    );

    expect(result.document!.name).toBe("CARBOCON GMBH");
    expect(result.issues.some((issue) => issue.includes("renamed"))).toBe(false);
  });
});

describe("mergeSourceRows", () => {
  it("unions the arrays and takes the first non-empty scalar", () => {
    const merged = mergeSourceRows([
      { id: "a", name: "WIRL INGENIEURE GMBH", trade: '["Tragwerksplanung"]', region: "" },
      { id: "b", name: "Wirl Ingenieure GmbH", trade: '["Bauphysik"]', region: "Halle" },
    ]);

    expect(toStringArray(merged.trade).sort()).toEqual(["Bauphysik", "Tragwerksplanung"]);
    expect(merged.name).toBe("WIRL INGENIEURE GMBH");
    // The survivor's region was blank, so the duplicate's fills the gap.
    expect(merged.region).toBe("Halle");
  });

  it("takes the richest object column from whichever row has one", () => {
    const merged = mergeSourceRows([
      { id: "a", knowledge_base: {} },
      { id: "b", knowledge_base: { contact_info: { email: "a@b.de" } } },
    ]);

    expect(mapKnowledgeBase(merged.knowledge_base).knowledgeBase).toEqual({
      contactInfo: { email: "a@b.de" },
    });
  });

  it("returns the single row unchanged", () => {
    const row = { id: "a", name: "Solo GmbH" };
    expect(mergeSourceRows([row])).toBe(row);
  });
});
