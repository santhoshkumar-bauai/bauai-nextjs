import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseGaeb } from "./parse";
import type { GaebDocument } from "./types";

function fixture(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
}

function parsed(name: string, extension: "x83" | "x84"): GaebDocument {
  const result = parseGaeb(fixture(name), extension);
  if (!result.ok) throw new Error(`fixture ${name} failed: ${result.error.code}`);
  return result.document;
}

describe("parseGaeb / x8x", () => {
  const document = parsed("minimal.x83", "x83");

  it("reads phase, version, and project meta", () => {
    expect(document.phase).toBe(83);
    expect(document.flavor).toBe("xml");
    expect(document.schemaVersion).toBe("3.2");
    expect(document.meta.projectName).toBe("Schulzentrum Musterstadt");
    expect(document.meta.boqName).toBe("LV Sanitaer und Heizung");
    expect(document.meta.currency).toBe("EUR");
    expect(document.meta.vatRate).toBe(19);
    expect(document.meta.buyer?.name).toBe("Stadt Musterstadt");
    expect(document.meta.buyer?.zip).toBe("06844");
    expect(document.meta.offerDeadline).toBe("2026-09-15");
    expect(document.stats.hasExistingPrices).toBe(false);
  });

  it("builds the category tree with composed OZ numbers", () => {
    expect(document.categories.map((category) => [category.oz, category.label])).toEqual([
      ["01", "Sanitaer"],
      ["01.01", "Demontage"],
      ["02", "Heizung"],
    ]);
    const demontage = document.categories[1];
    expect(demontage.parentKey).toBe(document.categories[0].key);
    expect(document.categories[0].childKeys).toEqual([demontage.key]);
    expect(demontage.itemKeys).toEqual(["i-0001", "i-0002"]);
  });

  it("assigns ordinal keys and zero-padded OZ per the mask", () => {
    expect(document.items.map((item) => item.key)).toEqual([
      "i-0001",
      "i-0002",
      "i-0003",
      "i-0004",
      "i-0005",
      "i-0006",
    ]);
    expect(document.items[0].oz).toBe("01.01.0003");
    expect(document.items[2].oz).toBe("02.0001");
    expect(document.items[0].sourceId).toBe("id1");
  });

  it("extracts quantities, units, and both text layers", () => {
    const first = document.items[0];
    expect(first.qty).toBe(50);
    expect(first.qtyUnit).toBe("lfdm");
    expect(first.shortText).toBe("Rohrleitungen Stahl demontieren");
    expect(first.longText).toContain("DN15 bis DN80");
    expect(first.longTextTruncated).toBe(false);
  });

  it("detects markers and total exclusion", () => {
    const byKey = new Map(document.items.map((item) => [item.sourceId, item]));
    expect(byKey.get("id2")?.markers).toContain("provisional");
    expect(byKey.get("id2")?.notInTotal).toBe(true);
    expect(byKey.get("id3")?.markers).toContain("lump_sum");
    expect(byKey.get("id3")?.qty).toBeNull();
    expect(byKey.get("id4")?.markers).toContain("alternative");
    expect(byKey.get("id4")?.notInTotal).toBe(false);
    expect(byKey.get("id5")?.notInTotal).toBe(true);
    expect(byKey.get("id5")?.alternative).toEqual({ groupNo: "1", seriesNo: "1" });
    expect(byKey.get("id6")?.markers).toContain("hourly");
  });

  it("collects remarks and award texts as preliminary text", () => {
    expect(document.preliminaryText).toContain("Vorbemerkungen");
    expect(document.preliminaryText).toContain("Schulbetrieb");
  });

  it("reads existing prices from an X84", () => {
    const priced = parsed("priced.x84", "x84");
    expect(priced.phase).toBe(84);
    expect(priced.stats.hasExistingPrices).toBe(true);
    expect(priced.items[0].existingUnitPrice).toBe(23.4);
    expect(priced.items[0].existingTotal).toBe(1170);
    expect(priced.meta.bidder?.name).toBe("Haustechnik Beispiel GmbH");
  });

  it("decodes ISO-8859-1 declared files", () => {
    const xml = [
      `<?xml version="1.0" encoding="ISO-8859-1"?>`,
      `<GAEB><Award><DP>83</DP><OWN><Address><Name1>Straße & Bäcker AG</Name1></Address></OWN>`,
      `<BoQ><BoQBody><Itemlist><Item RNoPart="1"><Qty>1.000</Qty><QU>St</QU>`,
      `<Description><CompleteText><DetailTxt><Text><p><span>Tür ausbauen</span></p></Text></DetailTxt></CompleteText></Description>`,
      `</Item></Itemlist></BoQBody></BoQ></Award></GAEB>`,
    ].join("");
    const result = parseGaeb(Buffer.from(xml, "latin1"), "x83");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.sourceEncoding).toBe("iso-8859-1");
    expect(result.document.meta.buyer?.name).toBe("Straße & Bäcker AG");
    expect(result.document.items[0].longText).toBe("Tür ausbauen");
  });

  it("falls back to dotted OZ when the mask is missing", () => {
    const xml =
      `<?xml version="1.0"?><GAEB><Award><DP>81</DP><BoQ><BoQBody>` +
      `<BoQCtgy RNoPart="1"><BoQBody><Itemlist><Item RNoPart="10"><Qty>2.000</Qty><QU>m</QU>` +
      `<Description><CompleteText><DetailTxt><Text><p><span>Testposition</span></p></Text></DetailTxt></CompleteText></Description>` +
      `</Item></Itemlist></BoQBody></BoQCtgy></BoQBody></BoQ></Award></GAEB>`;
    const result = parseGaeb(Buffer.from(xml, "utf8"), "x81");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.ozMask).toBeNull();
    expect(result.document.items[0].oz).toBe("1.10");
  });

  it("returns typed errors", () => {
    expect(parseGaeb(Buffer.from("", "utf8"), "x83")).toMatchObject({
      ok: false,
      error: { code: "invalid_xml" },
    });
    expect(parseGaeb(Buffer.from("<not-gaeb/>", "utf8"), "x83")).toMatchObject({
      ok: false,
      error: { code: "unrecognized_structure" },
    });
    expect(
      parseGaeb(Buffer.from(`<?xml version="1.0"?><GAEB><Award><DP>83</DP></Award></GAEB>`, "utf8"), "x83"),
    ).toMatchObject({ ok: false, error: { code: "empty_boq" } });
    expect(parseGaeb(fixture("minimal.x83"), "d83")).toMatchObject({
      ok: false,
      error: { code: "unsupported_flavor" },
    });
    expect(parseGaeb(fixture("minimal.x83"), "p83")).toMatchObject({
      ok: false,
      error: { code: "unsupported_flavor" },
    });
  });
});

describe("parseGaeb / real samples", () => {
  const realDir = fileURLToPath(new URL("./fixtures/real/", import.meta.url));
  const realFiles = existsSync(realDir)
    ? readdirSync(realDir).filter((name) => /\.x8[1-6]$/i.test(name))
    : [];

  it.skipIf(realFiles.length === 0)("parses every real sample", () => {
    for (const name of realFiles) {
      const extension = name.toLowerCase().slice(-3) as "x83";
      const result = parseGaeb(readFileSync(`${realDir}${name}`), extension);
      expect(result.ok, `${name}: ${result.ok ? "" : result.error.message}`).toBe(true);
      if (!result.ok) continue;
      expect(result.document.items.length).toBeGreaterThan(0);
      for (const item of result.document.items) {
        expect(item.key).toMatch(/^i-\d{4,}$/);
        expect(item.shortText.length).toBeGreaterThan(0);
      }
    }
  });
});
