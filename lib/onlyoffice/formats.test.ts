import { describe, expect, it } from "vitest";

import {
  WORKSPACE_ACCEPT,
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
    ["LV_Rohbau.x83", "gaeb", false],
    ["LV_Rohbau.X83", "gaeb", false],
    ["Angebot.d84", "gaeb", false],
    ["LV.p81", "gaeb", false],
  ])("maps %s", (fileName, documentType, requiresConversion) => {
    expect(workspaceFormat(fileName)).toMatchObject({ documentType, requiresConversion });
  });

  it("keeps GAEB files on their own extension without conversion", () => {
    expect(workspaceFormat("LV.x83")).toMatchObject({
      canonicalExtension: "x83",
      contentType: "application/octet-stream",
    });
    expect(WORKSPACE_ACCEPT).toContain(".x83");
    expect(WORKSPACE_ACCEPT).toContain(".d84");
    expect(WORKSPACE_ACCEPT).toContain(".p81");
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
