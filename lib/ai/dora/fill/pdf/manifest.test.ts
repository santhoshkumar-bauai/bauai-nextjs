import { beforeAll, describe, expect, it } from "vitest";

import {
  makeAcroFormFixture,
  makeDigitalFixture,
} from "@/tests/fixtures/document-fill/pdf/make-fixtures";

import { buildPdfManifest, fieldTypeOf, groupItemsIntoLines, type RawTextItem } from "./manifest";

let acroform: Buffer;
let digital: Buffer;

beforeAll(async () => {
  [acroform, digital] = await Promise.all([makeAcroFormFixture(), makeDigitalFixture()]);
});

const item = (over: Partial<RawTextItem>): RawTextItem => ({
  str: "x",
  x: 0,
  y: 700,
  width: 10,
  height: 11,
  fontSize: 11,
  hasEOL: false,
  ...over,
});

describe("groupItemsIntoLines", () => {
  it("groups items sharing a baseline and orders them left to right", () => {
    const lines = groupItemsIntoLines(
      [
        item({ str: "Welt", x: 60 }),
        item({ str: "Hallo", x: 20 }),
        item({ str: "Zweite", x: 20, y: 660 }),
      ],
      0,
      { x: 0, y: 0 },
    );
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe("Hallo Welt");
    // Highest baseline first, so indices read top-to-bottom.
    expect(lines[0].nodeId).toBe("tl:0:0");
    expect(lines[1].text).toBe("Zweite");
  });

  it("joins contiguous runs without inventing a space", () => {
    // Word splits a placeholder across runs; a tight gap is one word.
    const lines = groupItemsIntoLines(
      [item({ str: "Firmen", x: 20, width: 40 }), item({ str: "name", x: 60.5, width: 30 })],
      0,
      { x: 0, y: 0 },
    );
    expect(lines[0].text).toBe("Firmenname");
  });

  it("inserts a space when the gap exceeds a quarter of the font size", () => {
    const lines = groupItemsIntoLines(
      [item({ str: "PLZ", x: 20, width: 20 }), item({ str: "Ort", x: 80, width: 20 })],
      0,
      { x: 0, y: 0 },
    );
    expect(lines[0].text).toBe("PLZ Ort");
  });

  it("puts rect.y a descender BELOW the baseline", () => {
    // Drawing a highlight box at the baseline clips every g/j/p/q/y.
    const [line] = groupItemsIntoLines([item({ str: "Angebot", y: 700, fontSize: 10 })], 0, {
      x: 0,
      y: 0,
    });
    expect(line.baseline.y).toBe(700);
    expect(line.rect.y).toBeCloseTo(700 - 2.2, 5);
    expect(line.rect.y).toBeLessThan(line.baseline.y);
    expect(line.rect.height).toBeCloseTo(12.2, 5);
  });

  it("applies the crop offset so coordinates land in pdf-lib space", () => {
    const [line] = groupItemsIntoLines([item({ str: "A", x: 20, y: 700 })], 0, { x: 5, y: -7 });
    expect(line.baseline.x).toBe(25);
    expect(line.baseline.y).toBe(693);
  });

  it("drops whitespace-only items", () => {
    expect(groupItemsIntoLines([item({ str: "   " })], 0, { x: 0, y: 0 })).toEqual([]);
  });
});

describe("fieldTypeOf", () => {
  it("maps every pdf-lib field subclass", () => {
    expect(fieldTypeOf("PDFTextField")).toBe("text");
    expect(fieldTypeOf("PDFCheckBox")).toBe("checkbox");
    expect(fieldTypeOf("PDFRadioGroup")).toBe("radio");
    expect(fieldTypeOf("PDFDropdown")).toBe("dropdown");
    expect(fieldTypeOf("PDFOptionList")).toBe("optionlist");
    expect(fieldTypeOf("PDFSignature")).toBe("signature");
  });

  it("collapses buttons and anything unknown to a never-writable type", () => {
    expect(fieldTypeOf("PDFButton")).toBe("button");
    expect(fieldTypeOf("SomethingNew")).toBe("button");
  });
});

describe("buildPdfManifest — AcroForm", () => {
  it("describes every field with its real type, page and geometry", async () => {
    const manifest = await buildPdfManifest(acroform);
    const byName = new Map(manifest.acroFields.map((f) => [f.fieldName, f]));

    expect(byName.get("company.name")?.fieldType).toBe("text");
    expect(byName.get("company.prequalified")?.fieldType).toBe("checkbox");
    expect(byName.get("company.legalForm")?.fieldType).toBe("dropdown");
    expect(byName.get("company.trade")?.fieldType).toBe("radio");

    const name = byName.get("company.name")!;
    expect(name.page).toBe(0);
    // The widget /Rect spans the border, so it runs ~1pt past the requested
    // box. Assert the neighbourhood, not the nominal size.
    expect(name.rect.width).toBeGreaterThanOrEqual(300);
    expect(name.rect.width).toBeLessThanOrEqual(302);
    expect(name.rect.height).toBeGreaterThanOrEqual(18);
    expect(name.rect.height).toBeLessThanOrEqual(20);
    expect(name.nodeId).toMatch(/^af:\d+$/);
  });

  it("records linked widgets as one field, never as a duplicate", async () => {
    const manifest = await buildPdfManifest(acroform);
    const initials = manifest.acroFields.filter((f) => f.fieldName === "company.initials");
    expect(initials).toHaveLength(1);
    expect(initials[0].widgetCount).toBe(2);
  });

  it("flags read-only fields and preserves their current value", async () => {
    const manifest = await buildPdfManifest(acroform);
    const ref = manifest.acroFields.find((f) => f.fieldName === "meta.reference")!;
    expect(ref.readOnly).toBe(true);
    expect(ref.currentValue).toBe("VG-2026-0041");
  });

  it("exposes the allowed options for choice fields", async () => {
    const manifest = await buildPdfManifest(acroform);
    expect(manifest.acroFields.find((f) => f.fieldName === "company.legalForm")?.options).toEqual([
      "GmbH",
      "AG",
      "GmbH & Co. KG",
      "Einzelunternehmen",
    ]);
    expect(manifest.acroFields.find((f) => f.fieldName === "company.trade")?.options).toEqual([
      "Hochbau",
      "Tiefbau",
    ]);
  });

  it("resolves the page of a widget that lives on page 2", async () => {
    const manifest = await buildPdfManifest(acroform);
    expect(manifest.acroFields.find((f) => f.fieldName === "signature.authorized")?.page).toBe(1);
  });

  it("attaches the visible label as nearbyText", async () => {
    const manifest = await buildPdfManifest(acroform);
    const vat = manifest.acroFields.find((f) => f.fieldName === "company.vat")!;
    expect(vat.nearbyText).toContain("Umsatzsteuer");
  });
});

describe("buildPdfManifest — digital", () => {
  it("extracts labelled lines with usable geometry", async () => {
    const manifest = await buildPdfManifest(digital);
    const line = manifest.lines.find((l) => l.text.includes("Name des Unternehmens"))!;
    expect(line).toBeDefined();
    expect(line.page).toBe(0);
    expect(line.nodeId).toMatch(/^tl:0:\d+$/);
    expect(line.fontSize).toBeCloseTo(11, 0);
    expect(line.baseline.x).toBeCloseTo(56, 0);
    expect(line.items.length).toBeGreaterThan(0);
  });

  it("keeps rotated pages in unrotated user space", async () => {
    const manifest = await buildPdfManifest(digital);
    expect(manifest.classification.pages[1].rotation).toBe(90);
    const onPage2 = manifest.lines.filter((l) => l.page === 1);
    expect(onPage2.length).toBeGreaterThan(0);
    // Coordinates stay inside the UNROTATED MediaBox.
    for (const line of onPage2) {
      expect(line.baseline.x).toBeGreaterThanOrEqual(0);
      expect(line.baseline.x).toBeLessThanOrEqual(595.28);
      expect(line.baseline.y).toBeGreaterThanOrEqual(0);
      expect(line.baseline.y).toBeLessThanOrEqual(841.89);
    }
  });

  it("keeps the ambiguous label on both pages, so resolution can reject it", async () => {
    const manifest = await buildPdfManifest(digital);
    const hits = manifest.lines.filter((l) => l.text.includes("Ansprechpartner:"));
    expect(hits).toHaveLength(2);
    expect(new Set(hits.map((h) => h.page))).toEqual(new Set([0, 1]));
  });
});

describe("manifestHash", () => {
  it("is stable across two builds of identical bytes", async () => {
    const a = await buildPdfManifest(digital);
    const b = await buildPdfManifest(digital);
    expect(a.manifestHash).toBe(b.manifestHash);
  });

  it("differs between different documents", async () => {
    const a = await buildPdfManifest(digital);
    const b = await buildPdfManifest(acroform);
    expect(a.manifestHash).not.toBe(b.manifestHash);
  });
});
