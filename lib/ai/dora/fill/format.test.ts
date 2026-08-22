import { describe, expect, it } from "vitest";

import { fillFormatFor, fillRunFormat } from "./format";

describe("fillRunFormat", () => {
  it("treats rows written before PDF support as docx", () => {
    expect(fillRunFormat({})).toBe("docx");
  });

  it("honours an explicit format", () => {
    expect(fillRunFormat({ format: "pdf" })).toBe("pdf");
    expect(fillRunFormat({ format: "docx" })).toBe("docx");
  });
});

describe("fillFormatFor", () => {
  it("maps the two fillable shapes", () => {
    expect(fillFormatFor({ documentType: "word", extension: "docx" })).toBe("docx");
    expect(fillFormatFor({ documentType: "pdf", extension: "pdf" })).toBe("pdf");
  });

  it("refuses formats with no fill engine", () => {
    expect(fillFormatFor({ documentType: "cell", extension: "xlsx" })).toBeNull();
    expect(fillFormatFor({ documentType: "word", extension: "doc" })).toBeNull();
  });

  it("refuses a documentType/extension mismatch rather than guessing", () => {
    // A row where the two disagree is wrong; picking one would fill the wrong
    // engine and fail deep inside a worker instead of at the gate.
    expect(fillFormatFor({ documentType: "word", extension: "pdf" })).toBeNull();
    expect(fillFormatFor({ documentType: "pdf", extension: "docx" })).toBeNull();
  });
});
