import { describe, expect, it } from "vitest";

import {
  WORKSPACE_MAX_FILE_BYTES,
  fileNameWithExtension,
  validateWorkspaceFile,
  workspaceFormat,
} from "./formats";

describe("workspace document formats", () => {
  it.each([
    ["offer.docx", "word", false],
    ["prices.XLSX", "cell", false],
    ["form.pdf", "pdf", false],
    ["legacy.doc", "word", true],
    ["legacy.xls", "cell", true],
  ])("maps %s", (fileName, documentType, requiresConversion) => {
    expect(workspaceFormat(fileName)).toMatchObject({ documentType, requiresConversion });
  });

  it("rejects unsupported, empty, and oversized files", () => {
    expect(validateWorkspaceFile({ fileName: "slides.pptx", size: 1 })).toEqual({ error: "unsupported_file_type" });
    expect(validateWorkspaceFile({ fileName: "offer.docx", size: 0 })).toEqual({ error: "empty_file" });
    expect(validateWorkspaceFile({ fileName: "offer.docx", size: WORKSPACE_MAX_FILE_BYTES + 1 })).toEqual({ error: "file_too_large" });
  });

  it("changes legacy extensions without damaging Unicode names", () => {
    expect(fileNameWithExtension("Angebot & Preise.xls", "xlsx")).toBe("Angebot & Preise.xlsx");
  });
});
