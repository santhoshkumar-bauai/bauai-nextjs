import { describe, expect, it } from "vitest";

import type { StoredDoraSnapshot } from "./snapshot-schema";
import {
  compileContentMarkup,
  compileEditTransaction,
  editGroundingKind,
  isLikelyEditIntent,
  planDoraEditTransaction,
  textForTarget,
  toProviderSafeJsonSchema,
} from "./edit-v2";

function snapshot(overrides: Partial<StoredDoraSnapshot> = {}): StoredDoraSnapshot {
  return {
    _id: "54478574-1017-4c33-a4b1-2e3e9872d44e",
    tenantId: "tenant",
    documentId: "document",
    userId: "user",
    snapshotHash: "a".repeat(64),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    version: 2,
    editorKey: "editor-key",
    mode: "document",
    nodes: [
      {
        id: "body:p1",
        parentId: "body",
        surface: "body",
        kind: "paragraph",
        path: "body/p/0",
        order: 0,
        paragraphId: "p1",
        text: "Alpha first paragraph",
        rangeStart: 0,
        rangeEnd: 21,
        styleName: "Normal",
        formatting: { styleName: "Normal" },
        formattingHash: "fmt00001",
        editable: true,
        protectedReason: "",
      },
      {
        id: "body:p2",
        parentId: "body",
        surface: "body",
        kind: "paragraph",
        path: "body/p/1",
        order: 1,
        paragraphId: "p2",
        text: "Second paragraph Ω",
        rangeStart: 22,
        rangeEnd: 40,
        styleName: "Normal",
        formatting: { styleName: "Normal", bold: true },
        formattingHash: "fmt00002",
        editable: true,
        protectedReason: "",
      },
    ],
    styles: ["Normal", "Heading 2"],
    capabilities: {
      ranges: true,
      assistantTrackRevisions: true,
      headersFooters: true,
      notes: true,
      textBoxes: true,
      contentControls: true,
      forms: true,
    },
    ...overrides,
  };
}

function rawOperation(type: string) {
  return {
    type,
    startNodeId: "body:p1",
    endNodeId: "body:p1",
    startOffset: 0,
    endOffset: 5,
    contentMarkup: type === "update_table"
      ? "<table><tr><th>Item</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table>"
      : type === "replace_range" || type === "insert_fragment"
        ? "<p><strong>Better</strong> text</p>"
        : "",
    formatJson: type === "format_text" || type === "format_blocks"
      ? '{"bold":true,"alignment":"center"}'
      : "{}",
    formValue: type === "set_content_control" ? "Approved" : "",
    commentText: type === "comment" ? "Please verify this fact." : "",
    stylePolicy: "inherit",
    rationale: `Exercise ${type}`,
  };
}

function compile(rawOperations: ReturnType<typeof rawOperation>[], value = snapshot()) {
  return compileEditTransaction({
    snapshot: value,
    raw: {
      summary: "Apply a coherent set of edits",
      assistantMessage: "I prepared the requested suggestions.",
      operations: rawOperations,
    } as never,
    source: "selection",
    provider: "openai",
    providerModel: "test-model",
  });
}

describe("Dora V2 provider schema", () => {
  it("removes JSON Schema keywords that Gemini response schemas reject", () => {
    expect(
      toProviderSafeJsonSchema({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", minLength: 1, maxLength: 400 },
          count: { type: "integer", minimum: 0, maximum: 10 },
          values: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } },
        },
        required: ["text", "count", "values"],
      }),
    ).toEqual({
      type: "object",
      properties: {
        text: { type: "string" },
        count: { type: "integer" },
        values: { type: "array", items: { type: "string" } },
      },
      required: ["text", "count", "values"],
    });
  });
});

describe("Dora V2 edit intent routing", () => {
  it("routes common make/create phrasing through the structural edit workflow", () => {
    expect(isLikelyEditIntent("Make the conclusion more concise.")).toBe(true);
    expect(isLikelyEditIntent("Create a company profile section.")).toBe(true);
    expect(isLikelyEditIntent("What does the conclusion say?")).toBe(false);
  });
});

describe("Dora V2 fragment compiler", () => {
  it("compiles headings, rich inline runs, lists, tables, links and page breaks", () => {
    const blocks = compileContentMarkup(
      '<h2>Scope <em>summary</em></h2><ul><li><strong>One</strong></li></ul>' +
      '<p><a href="https://example.com">Source</a></p>' +
      '<table><tr><th>A</th><td><u>B</u></td></tr></table><page-break></page-break>',
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading", "list_item", "paragraph", "table", "page_break",
    ]);
    expect(blocks[0]).toMatchObject({ kind: "heading", level: 2 });
    expect(blocks[1]).toMatchObject({ kind: "list_item", ordered: false });
    expect(blocks[2]).toMatchObject({ runs: [{ text: "Source", href: "https://example.com" }] });
    expect(blocks[3].kind === "table" && blocks[3].rows[0]?.cells[0]?.header).toBe(true);
  });

  it("drops unsafe elements while preserving their text", () => {
    const blocks = compileContentMarkup('<script>alert(1)</script><p onclick="bad()">Safe</p>');
    expect(JSON.stringify(blocks)).not.toContain("onclick");
    expect(JSON.stringify(blocks)).not.toContain("script");
    expect(JSON.stringify(blocks)).toContain("Safe");
  });
});

describe("Dora V2 deterministic target validation", () => {
  it("requests bounded company/tender grounding only when the edit needs it", () => {
    expect(editGroundingKind("Fill the VAT and insurance fields for this tender")).toEqual({
      company: true,
      tender: true,
    });
    expect(editGroundingKind("Make the selected sentence shorter")).toEqual({
      company: false,
      tender: false,
    });
  });

  it("addresses multi-paragraph Unicode ranges by node and offset", () => {
    expect(textForTarget(snapshot(), "body:p1", "body:p2", 6, 18).text)
      .toBe("first paragraph\nSecond paragraph Ω");
  });

  it.each([
    "replace_range",
    "insert_fragment",
    "delete_range",
    "format_text",
    "format_blocks",
    "update_table",
    "set_content_control",
    "comment",
  ])("compiles the %s mutation with immutable text and formatting guards", (type) => {
    const transaction = compile([rawOperation(type)]);
    expect(transaction.operations[0]).toMatchObject({
      type,
      stylePolicy: "inherit",
      target: {
        startNodeId: "body:p1",
        expectedText: "Alpha",
        startFormattingHash: "fmt00001",
        endFormattingHash: "fmt00001",
      },
    });
    expect(transaction.operations[0].target.expectedTextHash).toHaveLength(64);
    expect(transaction.operations[0].target.nodeFormattingHashes).toEqual([
      { nodeId: "body:p1", hash: "fmt00001" },
    ]);
  });

  it("rejects overlapping mutations before a transaction can reach the editor", () => {
    const first = rawOperation("replace_range");
    const second = { ...rawOperation("delete_range"), startOffset: 3, endOffset: 8 };
    expect(() => compile([first, second])).toThrow("overlapping_operations");
  });

  it("rejects fields and OLE-protected targets", () => {
    const value = snapshot({
      nodes: [{ ...snapshot().nodes[0], editable: false, protectedReason: "field" }],
    });
    expect(() => compile([rawOperation("replace_range")], value)).toThrow("target_protected");
  });

  it("rejects edits that cross table cells even when both nodes share a surface", () => {
    const base = snapshot();
    const value = snapshot({
      nodes: [
        { ...base.nodes[0], id: "cell:a:p1", surface: "table_cell", parentId: "cell:a" },
        { ...base.nodes[1], id: "cell:b:p1", surface: "table_cell", parentId: "cell:b" },
      ],
    });
    const op = {
      ...rawOperation("replace_range"),
      startNodeId: "cell:a:p1",
      endNodeId: "cell:b:p1",
      endOffset: 5,
    };
    expect(() => compile([op], value)).toThrow("cross_container_target");
  });

  it("allows one body block-format operation to span embedded table/content nodes", () => {
    const base = snapshot();
    const value = snapshot({
      nodes: [
        base.nodes[0],
        {
          ...base.nodes[1],
          id: "cell:a:p1",
          surface: "table_cell",
          parentId: "cell:a",
          order: 1,
        },
        {
          ...base.nodes[1],
          id: "body:p3",
          paragraphId: "p3",
          parentId: "body",
          order: 2,
        },
      ],
    });
    const operation = {
      ...rawOperation("format_blocks"),
      endNodeId: "body:p3",
      endOffset: 6,
    };
    expect(compile([operation], value).operations[0].target.nodeFormattingHashes).toHaveLength(3);
    expect(() => compile([{ ...operation, type: "replace_range", contentMarkup: "<p>x</p>" }], value))
      .toThrow("cross_surface_target");
  });

  it("preserves inherit as the default rewrite style policy", () => {
    const transaction = compile([{ ...rawOperation("replace_range"), stylePolicy: "inherit" }]);
    expect(transaction.operations[0].stylePolicy).toBe("inherit");
    expect(transaction.operations[0].format).toEqual({});
  });

  it("repairs one invalid planner result before returning the transaction", async () => {
    const prompts: string[] = [];
    const invalid = {
      summary: "Invalid overlap",
      assistantMessage: "First attempt",
      operations: [
        rawOperation("replace_range"),
        { ...rawOperation("delete_range"), startOffset: 2, endOffset: 4 },
      ],
    };
    const valid = {
      summary: "Repaired",
      assistantMessage: "Second attempt",
      operations: [rawOperation("replace_range")],
    };
    const transaction = await planDoraEditTransaction({
      ctx: { locale: "en", document: { fileName: "fixture.docx" } } as never,
      snapshot: snapshot(),
      userMessage: "Rewrite the selection",
      source: "selection",
      planner: {
        provider: "fixture",
        providerModel: "fixture-model",
        invoke: async (prompt) => {
          prompts.push(prompt);
          return prompts.length === 1 ? invalid : valid;
        },
      },
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("overlapping_operations");
    expect(transaction.summary).toBe("Repaired");
  });
});
