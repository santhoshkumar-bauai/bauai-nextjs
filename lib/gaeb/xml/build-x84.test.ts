import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseGaeb } from "../parse";
import type { GaebDocument } from "../types";
import { buildX84, verifyX84 } from "./build-x84";

function fixture(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));
}

function parsed(bytes: Buffer): GaebDocument {
  const result = parseGaeb(bytes, "x83");
  if (!result.ok) throw new Error(result.error.code);
  return result.document;
}

const PRICES = new Map<string, number>([
  ["i-0001", 27.5],
  ["i-0002", 45],
  ["i-0003", 1500],
  ["i-0004", 30],
  ["i-0005", 33.333],
  ["i-0006", 58],
]);

describe("buildX84 / verifyX84", () => {
  const sourceBytes = fixture("minimal.x83");
  const source = parsed(sourceBytes);
  const bidder = {
    name: "Haustechnik Beispiel GmbH",
    street: "Werkstrasse 5",
    zip: "06846",
    city: "Musterstadt",
    contact: null,
    email: "angebot@beispiel.de",
  };
  const output = buildX84({ sourceBytes, source, prices: PRICES, bidder });
  const reparsed = parseGaeb(output, "x84");

  it("produces a parseable X84 with structure intact", () => {
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    const document = reparsed.document;
    expect(document.phase).toBe(84);
    expect(document.items.length).toBe(source.items.length);
    expect(document.items.map((item) => item.oz)).toEqual(source.items.map((item) => item.oz));
    expect(document.items.map((item) => item.qty)).toEqual(source.items.map((item) => item.qty));
    expect(document.items.map((item) => item.shortText)).toEqual(
      source.items.map((item) => item.shortText),
    );
    // Untouched surfaces survive verbatim.
    expect(document.meta.projectName).toBe(source.meta.projectName);
    expect(document.preliminaryText).toBe(source.preliminaryText);
  });

  it("writes unit prices and GAEB-rounded line totals", () => {
    if (!reparsed.ok) return;
    const byKey = new Map(reparsed.document.items.map((item) => [item.key, item]));
    expect(byKey.get("i-0001")?.existingUnitPrice).toBe(27.5);
    expect(byKey.get("i-0001")?.existingTotal).toBe(1375);
    // Lump sum without qty prices as one unit.
    expect(byKey.get("i-0003")?.existingUnitPrice).toBe(1500);
    expect(byKey.get("i-0003")?.existingTotal).toBe(1500);
    // Three-decimal UP survives; IT is rounded half away from zero.
    expect(byKey.get("i-0005")?.existingUnitPrice).toBe(33.333);
    expect(byKey.get("i-0005")?.existingTotal).toBe(666.66);
    expect(reparsed.document.stats.hasExistingPrices).toBe(true);
  });

  it("stamps DP, namespace, bidder block, and grand total", () => {
    const text = output.toString("utf8");
    expect(text).toContain("<DP>84</DP>");
    expect(text).toContain("GAEB_DA_XML/DA84/3.2");
    expect(text).toContain("<Name1>Haustechnik Beispiel GmbH</Name1>");
    // Net: 1375 (i1) + 1500 (i3) + 600 (i4) + 464 (i6); i2/i5 excluded.
    expect(text).toContain("<Total>3939.00</Total>");
    if (!reparsed.ok) return;
    expect(reparsed.document.meta.bidder?.name).toBe("Haustechnik Beispiel GmbH");
  });

  it("passes its own verification and fails on tampering", () => {
    expect(verifyX84(output, { source, prices: PRICES })).toEqual({ ok: true });

    const tampered = Buffer.from(
      output.toString("utf8").replace("<Qty>50.000</Qty>", "<Qty>51.000</Qty>"),
      "utf8",
    );
    const verdict = verifyX84(tampered, { source, prices: PRICES });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failures.some((failure) => failure.startsWith("qty:"))).toBe(true);
  });

  it("refuses mismatched sources instead of writing garbage", () => {
    const other = parsed(sourceBytes);
    // Simulate a canonical model that drifted from the bytes.
    (other.items[0] as { rNoPart: string }).rNoPart = "99";
    expect(() => buildX84({ sourceBytes, source: other, prices: PRICES, bidder: null })).toThrow(
      /x84_writer_item_misaligned/,
    );
  });

  it("preserves the declared legacy encoding", () => {
    const latinXml = [
      `<?xml version="1.0" encoding="ISO-8859-1"?>`,
      `<GAEB xmlns="http://www.gaeb.de/GAEB_DA_XML/DA83/3.2"><Award><DP>83</DP>`,
      `<BoQ><BoQBody><Itemlist><Item RNoPart="1"><Qty>2.000</Qty><QU>St</QU>`,
      `<Description><CompleteText><DetailTxt><Text><p><span>Tür mit Zubehör ausbauen</span></p></Text></DetailTxt>`,
      `<OutlineText><OutlTxt><TextOutlTxt><p><span>Tür ausbauen</span></p></TextOutlTxt></OutlTxt></OutlineText>`,
      `</CompleteText></Description></Item></Itemlist></BoQBody></BoQ></Award></GAEB>`,
    ].join("");
    const latinBytes = Buffer.from(latinXml, "latin1");
    const latinSource = parsed(latinBytes);
    const latinOut = buildX84({
      sourceBytes: latinBytes,
      source: latinSource,
      prices: new Map([["i-0001", 99.9]]),
      bidder: null,
    });
    // ü must be a single latin1 byte (0xFC), not a UTF-8 pair.
    expect(latinOut.includes(0xfc)).toBe(true);
    expect(latinOut.toString("latin1")).toContain("Tür ausbauen");
    const verdictSource = parseGaeb(latinOut, "x84");
    expect(verdictSource.ok).toBe(true);
    expect(verifyX84(latinOut, { source: latinSource, prices: new Map([["i-0001", 99.9]]) })).toEqual(
      { ok: true },
    );
  });
});
