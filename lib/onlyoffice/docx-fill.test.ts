import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { fillDocxBuffer } from "./docx-fill";

const fixture = resolve("tests/fixtures/document-fill/sample-word-template.docx");

describe("fillDocxBuffer", () => {
  it("fills exact targets in a copy and preserves sensitive placeholders and source bytes", async () => {
    const source = await readFile(fixture);
    const before = createHash("sha256").update(source).digest("hex");
    const output = await fillDocxBuffer(source, [
      { id: "name", value: "Nordbau Projekt GmbH", strategy: "form_key", nodeId: "form:name", path: "forms/0", formKey: "COMPANY_NAME" },
      { id: "registration", value: "HRB 184221", strategy: "unique_text", nodeId: "registration", path: "body/p/1", searchText: "{{REGISTRATION_NUMBER}}", occurrence: 1 },
    ]);
    expect(createHash("sha256").update(source).digest("hex")).toBe(before);
    expect(createHash("sha256").update(output).digest("hex")).not.toBe(before);

    const zip = await JSZip.loadAsync(output);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain("Nordbau Projekt GmbH");
    expect(xml).toContain("HRB 184221");
    expect(xml).toContain("{{AUTHORIZED_SIGNATURE}}");
    expect(xml).toContain("{{GL_POLICY_NUMBER}}");
  });

  it("rejects missing and duplicate locators before generating a copy", async () => {
    const source = await readFile(fixture);
    await expect(fillDocxBuffer(source, [
      { id: "missing", value: "x", strategy: "unique_text", nodeId: "n", path: "body", searchText: "{{DOES_NOT_EXIST}}", occurrence: 1 },
    ])).rejects.toThrow("locator_preflight_failed:missing:0");
    await expect(fillDocxBuffer(source, [
      { id: "one", value: "a", strategy: "form_key", nodeId: "n1", path: "forms/0", formKey: "VAT_NUMBER" },
      { id: "two", value: "b", strategy: "form_key", nodeId: "n2", path: "forms/0", formKey: "VAT_NUMBER" },
    ])).rejects.toThrow("duplicate_fill_locator");
  });
});
