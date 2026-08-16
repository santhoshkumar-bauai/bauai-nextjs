import { describe, expect, it } from "vitest";

import { doraEditorSnapshotInputSchema } from "./snapshot-schema";
import { snapshotHash } from "./snapshots";

function validSnapshot() {
  return {
    version: 2 as const,
    editorKey: "editor-key-7",
    mode: "selection" as const,
    nodes: [
      {
        id: "body:p1",
        parentId: "body",
        surface: "body" as const,
        kind: "paragraph" as const,
        path: "body/p/0",
        order: 0,
        paragraphId: "p1",
        text: "Alpha βeta",
        rangeStart: 0,
        rangeEnd: 10,
        styleName: "Normal",
        formatting: { alignment: "left" },
        formattingHash: "01abc234",
        editable: true,
        protectedReason: "",
      },
    ],
    selection: {
      startNodeId: "body:p1",
      endNodeId: "body:p1",
      startOffset: 0,
      endOffset: 5,
      text: "Alpha",
    },
    styles: ["Normal"],
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

describe("Dora live snapshot contract", () => {
  it("accepts a bounded structural selection and hashes it deterministically", () => {
    const snapshot = doraEditorSnapshotInputSchema.parse(validSnapshot());
    expect(snapshotHash(snapshot)).toHaveLength(64);
    expect(snapshotHash(snapshot)).toBe(snapshotHash(structuredClone(snapshot)));
  });

  it("rejects duplicate node IDs", () => {
    const snapshot = validSnapshot();
    snapshot.nodes.push({ ...snapshot.nodes[0], order: 1 });
    expect(() => doraEditorSnapshotInputSchema.parse(snapshot)).toThrow(/duplicate node id/i);
  });

  it("rejects selections that reference nodes outside the bearer snapshot", () => {
    const snapshot = validSnapshot();
    snapshot.selection.endNodeId = "body:missing";
    expect(() => doraEditorSnapshotInputSchema.parse(snapshot)).toThrow(/selection node missing/i);
  });

  it("rejects reversed live ranges", () => {
    const snapshot = validSnapshot();
    snapshot.nodes[0].rangeStart = 20;
    expect(() => doraEditorSnapshotInputSchema.parse(snapshot)).toThrow(/rangeEnd/i);
  });
});
