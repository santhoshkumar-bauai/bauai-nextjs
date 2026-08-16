/** Client-safe Dora V2 edit protocol. This module must stay free of server imports. */

export type WireDoraSurface =
  | "body"
  | "header"
  | "footer"
  | "footnote"
  | "endnote"
  | "table_cell"
  | "content_control"
  | "text_box";

export type WireDoraMutationType =
  | "replace_range"
  | "insert_fragment"
  | "delete_range"
  | "format_text"
  | "format_blocks"
  | "update_table"
  | "set_content_control"
  | "comment";

export interface WireDoraInlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  href?: string;
}

export type WireDoraFragmentBlock =
  | { kind: "paragraph"; runs: WireDoraInlineRun[] }
  | { kind: "heading"; level: 1 | 2 | 3 | 4; runs: WireDoraInlineRun[] }
  | { kind: "list_item"; ordered: boolean; level: number; runs: WireDoraInlineRun[] }
  | {
      kind: "table";
      rows: Array<{ cells: Array<{ runs: WireDoraInlineRun[]; header: boolean }> }>;
    }
  | { kind: "page_break" };

export interface WireDoraRangeRef {
  surface: WireDoraSurface;
  startNodeId: string;
  endNodeId: string;
  startOffset: number;
  endOffset: number;
  expectedText: string;
  expectedTextHash: string;
  expectedFormattingHash: string;
  startFormattingHash: string;
  endFormattingHash: string;
  nodeFormattingHashes: Array<{ nodeId: string; hash: string }>;
  startOrder: number;
  endOrder: number;
}

export interface WireDoraFormatSpec {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  highlight?: string;
  alignment?: "left" | "center" | "right" | "justify";
  styleName?: string;
  spacingBefore?: number;
  spacingAfter?: number;
  lineSpacing?: number;
}

export interface WireDoraEditOperation {
  opId: string;
  type: WireDoraMutationType;
  target: WireDoraRangeRef;
  fragment: WireDoraFragmentBlock[];
  format: WireDoraFormatSpec;
  formValue: string;
  commentText: string;
  stylePolicy: "inherit" | "match_neighbor" | "explicit";
  rationale: string;
}

export interface WireDoraEditTransaction {
  version: 2;
  transactionId: string;
  snapshotId: string;
  snapshotHash: string;
  editorKey: string;
  summary: string;
  assistantMessage: string;
  source: "selection" | "composer";
  model: { provider: string; providerModel: string; promptVersion: string };
  operations: WireDoraEditOperation[];
}

export type WireDoraEditStatusStage =
  | "reading"
  | "researching"
  | "planning"
  | "validating"
  | "applying"
  | "replanning"
  | "complete";
