/** Client-safe spreadsheet transaction wire types. */
export type SpreadsheetScalar = string | number | boolean | null;

export interface WireSpreadsheetChangeOperation {
  opId: string;
  type: "set_values" | "set_formulas";
  target: string;
  matrix: SpreadsheetScalar[][];
  beforeValues: SpreadsheetScalar[][];
  beforeFormulas: Array<{ row: number; column: number; formula: string }>;
  affectedCells: number;
  overwritesNonEmpty: boolean;
}

export interface WireSpreadsheetChangeSet {
  version: 1;
  changeSetId: string;
  contextId: string;
  editorKey: string;
  workbookRevision: number;
  sheetId: string;
  sheetName: string;
  selectionAddress: string;
  summary: string;
  risk: "normal" | "strong";
  affectedCells: number;
  operations: WireSpreadsheetChangeOperation[];
  model: { provider: string; providerModel: string; promptVersion: string };
}
