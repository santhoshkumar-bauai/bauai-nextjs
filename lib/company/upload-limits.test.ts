import { describe, expect, it } from "vitest";

import {
  MAX_UPLOAD_BYTES,
  resolveContentType,
  validateCompanyUpload,
} from "./upload-limits.ts";

describe("resolveContentType", () => {
  it("prefers the type the browser reported", () => {
    expect(resolveContentType({ name: "profile.pdf", type: "application/pdf" })).toBe(
      "application/pdf",
    );
  });

  it("falls back to the extension when the browser reports nothing", () => {
    expect(resolveContentType({ name: "Zertifikat.DOCX", type: "" })).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("returns an empty string for unknown extensions", () => {
    expect(resolveContentType({ name: "archive.zip" })).toBe("");
  });
});

describe("validateCompanyUpload", () => {
  const pdf = { name: "a.pdf", type: "application/pdf", size: 1024 };

  it("accepts a supported document", () => {
    expect(validateCompanyUpload(pdf, "general")).toBeNull();
  });

  it("rejects files over the size limit", () => {
    expect(
      validateCompanyUpload({ ...pdf, size: MAX_UPLOAD_BYTES + 1 }, "general"),
    ).toBe("size");
  });

  it("rejects empty files", () => {
    expect(validateCompanyUpload({ ...pdf, size: 0 }, "general")).toBe("empty");
  });

  it("rejects types the API would refuse", () => {
    expect(
      validateCompanyUpload(
        { name: "notes.zip", type: "application/zip", size: 10 },
        "general",
      ),
    ).toBe("type");
  });

  it("applies the logo allow-list to logo uploads", () => {
    const svg = { name: "logo.svg", type: "image/svg+xml", size: 512 };
    expect(validateCompanyUpload(svg, "logo")).toBeNull();
    // SVG is fine for a logo but not for a knowledge-base document.
    expect(validateCompanyUpload(svg, "general")).toBe("type");
    expect(validateCompanyUpload(pdf, "logo")).toBe("type");
  });
});
