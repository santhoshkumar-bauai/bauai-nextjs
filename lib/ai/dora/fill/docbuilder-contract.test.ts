import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("document fill builder contract", () => {
  it("preflights unique locations, fills native forms, and saves a new DOCX", async () => {
    const script = await readFile(resolve("public/onlyoffice/document-fill.docbuilder"), "utf8");
    expect(script).toContain("ranges.length !== 1");
    expect(script).toContain("doc.SetFormsData(forms)");
    expect(script).toContain('builder.SaveFile("docx", "filled.docx")');
    expect(script).not.toContain("builder.SaveFile(input.sourceUrl");
  });
});
