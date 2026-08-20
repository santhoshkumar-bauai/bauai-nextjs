import { z } from "zod";

export const SPREADSHEET_CONTEXT_VERSION = 1 as const;
export const SPREADSHEET_ACTIVE_CELL_LIMIT = 1_500;
export const SPREADSHEET_CONTEXT_CHAR_LIMIT = 60_000;

const scalarSchema = z.union([
  z.string().max(4_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const matrixSchema = z.array(z.array(scalarSchema).max(200)).max(2_000);
const textMatrixSchema = z.array(z.array(z.string().max(4_000)).max(200)).max(2_000);

const sparseFormulaSchema = z.object({
  row: z.number().int().min(0).max(1_999),
  column: z.number().int().min(0).max(199),
  formula: z.string().max(8_192),
}).strict();

const sparseFormatSchema = z.object({
  row: z.number().int().min(0).max(1_999),
  column: z.number().int().min(0).max(199),
  numberFormat: z.string().max(256),
}).strict();

export const spreadsheetCapabilitiesSchema = z.object({
  activeContext: z.boolean(),
  rangeRead: z.boolean(),
  formulas: z.boolean(),
  numberFormats: z.boolean(),
  workbookSummary: z.boolean(),
  writes: z.boolean(),
  developerConnector: z.boolean(),
}).strict();

export const spreadsheetRangeContextSchema = z.object({
  sheetId: z.string().min(1).max(256),
  sheetName: z.string().min(1).max(128),
  address: z.string().min(1).max(128),
  rowCount: z.number().int().min(1).max(2_000),
  columnCount: z.number().int().min(1).max(200),
  values: matrixSchema,
  displayText: textMatrixSchema.optional(),
  formulas: z.array(sparseFormulaSchema).max(SPREADSHEET_ACTIVE_CELL_LIMIT).optional(),
  numberFormats: z.array(sparseFormatSchema).max(SPREADSHEET_ACTIVE_CELL_LIMIT).optional(),
  truncated: z.boolean(),
}).strict().superRefine((range, ctx) => {
  if (range.rowCount * range.columnCount > SPREADSHEET_ACTIVE_CELL_LIMIT && !range.truncated) {
    ctx.addIssue({
      code: "custom",
      message: "oversized range must be truncated",
      path: ["truncated"],
    });
  }
  const returnedCells = range.values.reduce((total, row) => total + row.length, 0);
  if (returnedCells > SPREADSHEET_ACTIVE_CELL_LIMIT) {
    ctx.addIssue({ code: "custom", message: "too many returned cells", path: ["values"] });
  }
});

const spreadsheetSheetSummarySchema = z.object({
  sheetId: z.string().min(1).max(256),
  name: z.string().min(1).max(128),
  index: z.number().int().min(0).max(999),
  visible: z.boolean(),
  protected: z.boolean(),
  usedRange: z.string().max(128).optional(),
  estimatedCells: z.number().int().min(0).max(100_000_000),
}).strict();

export const spreadsheetContextInputSchema = z.object({
  version: z.literal(SPREADSHEET_CONTEXT_VERSION),
  editorKey: z.string().min(1).max(256),
  workbookRevision: z.number().int().min(0),
  active: z.object({
    sheetId: z.string().min(1).max(256),
    sheetName: z.string().min(1).max(128),
    sheetIndex: z.number().int().min(0).max(999),
    address: z.string().min(1).max(128),
  }).strict(),
  sheets: z.array(spreadsheetSheetSummarySchema).max(500),
  selection: spreadsheetRangeContextSchema.optional(),
  capabilities: spreadsheetCapabilitiesSchema,
}).strict().superRefine((packet, ctx) => {
  if (JSON.stringify(packet).length > SPREADSHEET_CONTEXT_CHAR_LIMIT) {
    ctx.addIssue({ code: "custom", message: "spreadsheet context is too large" });
  }
  if (packet.selection && packet.selection.sheetId !== packet.active.sheetId) {
    ctx.addIssue({
      code: "custom",
      message: "selection must belong to the active sheet",
      path: ["selection", "sheetId"],
    });
  }
});

export type SpreadsheetContextInput = z.infer<typeof spreadsheetContextInputSchema>;

export interface StoredSpreadsheetContext extends SpreadsheetContextInput {
  _id: string;
  tenantId: string;
  documentId: string;
  userId: string;
  contextHash: string;
  createdAt: Date;
  expiresAt: Date;
}
