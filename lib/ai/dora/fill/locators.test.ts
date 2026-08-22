import { describe, expect, it } from "vitest";

import { canAutoApply, locatorKey } from "./locators";
import type { DocumentFillLocator } from "./types";

const rect = { x: 100, y: 200, width: 180, height: 14 };

const LOCATORS: Record<string, DocumentFillLocator> = {
  form_key: { strategy: "form_key", nodeId: "n1", path: "body/0", formKey: "COMPANY_NAME" },
  unique_text: {
    strategy: "unique_text",
    nodeId: "n2",
    path: "body/1",
    searchText: "{{VAT}}",
    occurrence: 1,
  },
  pdf_acroform: {
    strategy: "pdf_acroform",
    nodeId: "af:0",
    page: 0,
    fieldName: "company.name",
    fieldType: "text",
    widgetCount: 1,
    rect,
  },
  pdf_overlay_text: {
    strategy: "pdf_overlay_text",
    nodeId: "tl:0:3",
    page: 0,
    anchorText: "Firmenname:",
    anchorOccurrence: 1,
    rect,
    baseline: { x: 100, y: 203 },
    fontSize: 11,
    whiteout: false,
  },
  pdf_overlay_vision: {
    strategy: "pdf_overlay_vision",
    nodeId: "vis:0:100:200",
    page: 0,
    rect,
    baseline: { x: 100, y: 203 },
    fontSize: 11,
    nearestText: "Firmenname",
  },
};

describe("canAutoApply", () => {
  it("accepts every deterministically verifiable strategy", () => {
    for (const key of ["form_key", "unique_text", "pdf_acroform", "pdf_overlay_text"]) {
      expect(canAutoApply(LOCATORS[key]), key).toBe(true);
    }
  });

  it("refuses vision geometry, which nothing verifies", () => {
    expect(canAutoApply(LOCATORS.pdf_overlay_vision)).toBe(false);
  });

  it("refuses a missing locator", () => {
    expect(canAutoApply(null)).toBe(false);
  });
});

describe("locatorKey", () => {
  it("gives every strategy a distinct namespace", () => {
    const keys = Object.values(LOCATORS).map(locatorKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("collides when two instructions target the same thing", () => {
    // The point of the key: two discovered fields pointing at one AcroForm
    // field must be caught, even though their field ids and rects differ.
    const a = locatorKey(LOCATORS.pdf_acroform);
    const b = locatorKey({
      ...(LOCATORS.pdf_acroform as Extract<DocumentFillLocator, { strategy: "pdf_acroform" }>),
      nodeId: "af:7",
      rect: { ...rect, y: 9 },
    });
    expect(a).toBe(b);
  });

  it("keeps the same anchor on different pages apart", () => {
    const anchor = LOCATORS.pdf_overlay_text as Extract<
      DocumentFillLocator,
      { strategy: "pdf_overlay_text" }
    >;
    expect(locatorKey(anchor)).not.toBe(locatorKey({ ...anchor, page: 1 }));
  });
});
