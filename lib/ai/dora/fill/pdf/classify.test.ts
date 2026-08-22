import { beforeAll, describe, expect, it } from "vitest";

import {
  makeAcroFormFixture,
  makeDigitalFixture,
  makeScannedLikeFixture,
} from "@/tests/fixtures/document-fill/pdf/make-fixtures";

import { classifyPdf, countTextChars } from "./classify";

let acroform: Buffer;
let digital: Buffer;
let scanned: Buffer;

beforeAll(async () => {
  [acroform, digital, scanned] = await Promise.all([
    makeAcroFormFixture(),
    makeDigitalFixture(),
    makeScannedLikeFixture(),
  ]);
});

describe("classifyPdf", () => {
  it("detects an interactive form", async () => {
    const result = await classifyPdf(acroform);
    expect(result.documentClass).toBe("acroform");
    expect(result.acroFieldCount).toBeGreaterThan(8);
    expect(result.pageCount).toBe(2);
  });

  it("detects a flat PDF with a text layer", async () => {
    const result = await classifyPdf(digital);
    expect(result.documentClass).toBe("digital");
    expect(result.acroFieldCount).toBe(0);
    expect(result.charsPerPage).toBeGreaterThanOrEqual(120);
  });

  it("detects a page with no extractable text", async () => {
    const result = await classifyPdf(scanned);
    expect(result.documentClass).toBe("scanned");
    expect(result.textCharCount).toBe(0);
  });

  it("reports MediaBox geometry and rotation per page", async () => {
    const result = await classifyPdf(digital);
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0].width).toBeCloseTo(595.28, 1);
    expect(result.pages[0].height).toBeCloseTo(841.89, 1);
    expect(result.pages[0].rotation).toBe(0);
    // Page 2 is rotated; the geometry records it but coordinates stay unrotated.
    expect(result.pages[1].rotation).toBe(90);
  });

  it("reports a zero crop offset when CropBox equals MediaBox", async () => {
    const result = await classifyPdf(acroform);
    for (const page of result.pages) {
      expect(page.cropOffset).toEqual({ x: 0, y: 0 });
    }
  });

  it("honours the digital/scanned threshold", async () => {
    const original = process.env.PDF_DIGITAL_MIN_CHARS_PER_PAGE;
    try {
      // Absurdly high: a genuine text layer is now judged insufficient.
      process.env.PDF_DIGITAL_MIN_CHARS_PER_PAGE = "100000";
      expect((await classifyPdf(digital)).documentClass).toBe("scanned");
      process.env.PDF_DIGITAL_MIN_CHARS_PER_PAGE = "1";
      expect((await classifyPdf(digital)).documentClass).toBe("digital");
    } finally {
      if (original === undefined) delete process.env.PDF_DIGITAL_MIN_CHARS_PER_PAGE;
      else process.env.PDF_DIGITAL_MIN_CHARS_PER_PAGE = original;
    }
  });

  it("rejects bytes that are not a readable PDF", async () => {
    await expect(classifyPdf(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(
      /pdf_unreadable|pdf_encrypted/,
    );
  });
});

describe("countTextChars", () => {
  it("counts trimmed content and ignores whitespace-only runs", () => {
    expect(countTextChars([[{ str: "abc" }, { str: "  " }], [{ str: " de " }]])).toBe(5);
  });
});
