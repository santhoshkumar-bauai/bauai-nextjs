import { z } from "zod";

/**
 * V2 editor snapshots are produced by the live ONLYOFFICE document, not by
 * Mammoth.  They deliberately contain only serialisable document structure;
 * no sdkjs object ever crosses the editor/gateway boundary.
 */

export const DORA_SNAPSHOT_VERSION = 2 as const;
export const MAX_SNAPSHOT_NODES = 8_000;
export const MAX_SNAPSHOT_CHARS = 750_000;

export const doraSurfaceSchema = z.enum([
  "body",
  "header",
  "footer",
  "footnote",
  "endnote",
  "table_cell",
  "content_control",
  "text_box",
]);

export const doraNodeKindSchema = z.enum([
  "paragraph",
  "heading",
  "list_item",
  "table_cell",
  "content_control",
  "form",
  "text_box",
  "field",
]);

const jsonRecordSchema = z.record(
  z.string().max(100),
  z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()]),
);

export const doraSnapshotNodeSchema = z.object({
  id: z.string().min(1).max(160),
  parentId: z.string().max(160).default(""),
  surface: doraSurfaceSchema,
  kind: doraNodeKindSchema,
  path: z.string().min(1).max(300),
  order: z.number().int().min(0).max(MAX_SNAPSHOT_NODES * 2),
  paragraphId: z.string().max(100).default(""),
  text: z.string().max(50_000),
  rangeStart: z.number().int().min(0).default(0),
  rangeEnd: z.number().int().min(0).default(0),
  styleName: z.string().max(160).default(""),
  formatting: jsonRecordSchema.default({}),
  formattingHash: z.string().max(64).default(""),
  editable: z.boolean().default(true),
  protectedReason: z.string().max(160).default(""),
  /** Stable ONLYOFFICE form key, present only for native fillable controls. */
  formKey: z.string().max(300).optional(),
});

export const doraSelectionSchema = z.object({
  startNodeId: z.string().min(1).max(160),
  endNodeId: z.string().min(1).max(160),
  startOffset: z.number().int().min(0).max(50_000),
  endOffset: z.number().int().min(0).max(50_000),
  text: z.string().max(100_000),
});

export const doraEditorSnapshotInputSchema = z
  .object({
    version: z.literal(DORA_SNAPSHOT_VERSION),
    editorKey: z.string().min(1).max(160),
    mode: z.enum(["selection", "document"]),
    nodes: z.array(doraSnapshotNodeSchema).min(1).max(MAX_SNAPSHOT_NODES),
    selection: doraSelectionSchema.optional(),
    styles: z.array(z.string().min(1).max(160)).max(500).default([]),
    capabilities: z
      .object({
        ranges: z.boolean(),
        assistantTrackRevisions: z.boolean(),
        headersFooters: z.boolean(),
        notes: z.boolean(),
        textBoxes: z.boolean(),
        contentControls: z.boolean(),
        forms: z.boolean(),
      })
      .strict(),
  })
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    let chars = 0;
    for (const [index, node] of value.nodes.entries()) {
      chars += node.text.length;
      if (ids.has(node.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", index, "id"],
          message: "duplicate node id",
        });
      }
      ids.add(node.id);
      if (node.rangeEnd < node.rangeStart) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", index, "rangeEnd"],
          message: "rangeEnd must be >= rangeStart",
        });
      }
    }
    if (chars > MAX_SNAPSHOT_CHARS) {
      ctx.addIssue({ code: "custom", path: ["nodes"], message: "snapshot text too large" });
    }
    if (value.selection) {
      if (!ids.has(value.selection.startNodeId) || !ids.has(value.selection.endNodeId)) {
        ctx.addIssue({ code: "custom", path: ["selection"], message: "selection node missing" });
      }
    }
  });

export type DoraSurface = z.infer<typeof doraSurfaceSchema>;
export type DoraSnapshotNode = z.infer<typeof doraSnapshotNodeSchema>;
export type DoraSelection = z.infer<typeof doraSelectionSchema>;
export type DoraEditorSnapshotInput = z.infer<typeof doraEditorSnapshotInputSchema>;

export interface StoredDoraSnapshot extends DoraEditorSnapshotInput {
  _id: string;
  tenantId: string;
  documentId: string;
  userId: string;
  snapshotHash: string;
  createdAt: Date;
  expiresAt: Date;
}
