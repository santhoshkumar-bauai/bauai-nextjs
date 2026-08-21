import { describe, expect, it } from "vitest";

import type { DoraEditorSnapshotInput } from "@/lib/dora-gateway/snapshot-schema";

import { resolveDiscoveredFields } from "./resolve";

function snapshot(nodes: DoraEditorSnapshotInput["nodes"]): DoraEditorSnapshotInput {
  return {
    version: 2,
    editorKey: "doc-r1",
    mode: "document",
    nodes,
    styles: [],
    capabilities: {
      ranges: true,
      assistantTrackRevisions: true,
      headersFooters: true,
      notes: true,
      textBoxes: true,
      contentControls: true,
      forms: true,
    },
  };
}

const node = (overrides: Partial<DoraEditorSnapshotInput["nodes"][number]> = {}) => ({
  id: "n1",
  parentId: "body",
  surface: "body" as const,
  kind: "paragraph" as const,
  path: "body/p/0",
  order: 0,
  paragraphId: "p1",
  text: "Legal company name: {{COMPANY_NAME}}",
  rangeStart: 0,
  rangeEnd: 36,
  styleName: "Normal",
  formatting: {},
  formattingHash: "abc",
  editable: true,
  protectedReason: "",
  ...overrides,
});

describe("resolveDiscoveredFields", () => {
  it("marks a high-confidence evidenced unique placeholder ready", () => {
    const fields = resolveDiscoveredFields({
      snapshot: snapshot([node()]),
      evidence: new Map([
        ["company.name", { source: "company_profile", reference: "company.name", excerpt: "Nordbau GmbH" }],
      ]),
      discovery: {
        fields: [{
          nodeId: "n1", label: "Legal company name", description: "", required: true,
          sensitive: false, targetText: "{{COMPANY_NAME}}", value: "Nordbau GmbH",
          confidence: 0.98, evidenceReferences: ["company.name"], reason: "Exact profile match",
        }],
      },
    });
    expect(fields[0]).toMatchObject({ state: "ready", value: "Nordbau GmbH" });
    expect(fields[0].locator).toEqual({
      strategy: "unique_text", nodeId: "n1", path: "body/p/0",
      searchText: "{{COMPANY_NAME}}", occurrence: 1,
    });
  });

  it("refuses an ambiguous placeholder and all signature fields", () => {
    const fields = resolveDiscoveredFields({
      snapshot: snapshot([
        node(),
        node({ id: "n2", order: 1, path: "body/p/1", text: "Again {{COMPANY_NAME}}" }),
        node({ id: "n3", order: 2, path: "body/p/2", text: "Signature: {{SIGNATURE}}" }),
      ]),
      evidence: new Map([
        ["company.name", { source: "company_profile", reference: "company.name", excerpt: "Nordbau GmbH" }],
      ]),
      discovery: { fields: [
        { nodeId: "n1", label: "Company", description: "", required: true, sensitive: false, targetText: "{{COMPANY_NAME}}", value: "Nordbau GmbH", confidence: 0.99, evidenceReferences: ["company.name"], reason: "" },
        { nodeId: "n3", label: "Authorized signature", description: "attestation", required: true, sensitive: false, targetText: "{{SIGNATURE}}", value: "Markus Weber", confidence: 0.99, evidenceReferences: ["company.name"], reason: "" },
      ] },
    });
    expect(fields[0]).toMatchObject({ state: "needs_review", locator: null });
    expect(fields[1]).toMatchObject({ state: "manual", sensitive: true });
  });

  it("uses a native form key as the exact locator", () => {
    const fields = resolveDiscoveredFields({
      snapshot: snapshot([node({ id: "form1", kind: "form", surface: "content_control", formKey: "VAT_NUMBER", text: "" })]),
      evidence: new Map([
        ["company.vatNumber", { source: "company_profile", reference: "company.vatNumber", excerpt: "DE123" }],
      ]),
      discovery: { fields: [{ nodeId: "form1", label: "VAT ID", description: "", required: false, sensitive: false, targetText: "", value: "DE123", confidence: 0.95, evidenceReferences: ["company.vatNumber"], reason: "" }] },
    });
    expect(fields[0]).toMatchObject({ state: "ready" });
    expect(fields[0].locator).toEqual({ strategy: "form_key", nodeId: "form1", path: "body/p/0", formKey: "VAT_NUMBER" });
  });
});
