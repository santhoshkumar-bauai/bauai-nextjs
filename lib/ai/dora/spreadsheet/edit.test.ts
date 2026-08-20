import { describe, expect, it } from "vitest";

import type { StoredSpreadsheetContext } from "@/lib/dora-gateway/spreadsheet-schema";

import type { DoraRunContext } from "../context";
import { planSpreadsheetChangeSet } from "./edit";

function context(writes = true): StoredSpreadsheetContext {
  return {
    _id: "11111111-1111-4111-8111-111111111111",
    version: 1,
    editorKey: "editor-key",
    workbookRevision: 4,
    active: { sheetId: "sheet-1", sheetName: "Sheet1", sheetIndex: 0, address: "A1:E3" },
    sheets: [{ sheetId: "sheet-1", name: "Sheet1", index: 0, visible: true, protected: false, usedRange: "A1:E3", estimatedCells: 15 }],
    selection: {
      sheetId: "sheet-1", sheetName: "Sheet1", address: "A1:E3", rowCount: 3, columnCount: 5,
      values: [
        ["Category", "Budget", "Actual", "Difference", "Notes"],
        ["Housing", 1500, 1500, 0, "Rent"],
        ["Food", 400, 425, -25, "Monthly food"],
      ],
      displayText: [], formulas: [], numberFormats: [], truncated: false,
    },
    capabilities: { activeContext: true, rangeRead: true, formulas: true, numberFormats: true, workbookSummary: true, writes, developerConnector: false },
    tenantId: "tenant", documentId: "document", userId: "user", contextHash: "hash",
    createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
  };
}

const ctx = {
  locale: "en",
  document: { fileName: "budget.xlsx" },
} as unknown as DoraRunContext;

function planner(output: unknown) {
  return { invoke: async () => output, provider: "test", providerModel: "test-model" };
}

describe("spreadsheet edit compiler", () => {
  it("compiles an in-selection value change with a before-image", async () => {
    const changeSet = await planSpreadsheetChangeSet({
      ctx, context: context(), message: "Change the food note",
      planner: planner({
        summary: "Update the food note.",
        operations: [{ type: "set_values", target: "E3", matrixJson: '[["Groceries"]]' }],
      }),
    });
    expect(changeSet.operations[0]).toMatchObject({
      type: "set_values", target: "E3", matrix: [["Groceries"]],
      beforeValues: [["Monthly food"]], overwritesNonEmpty: true,
    });
    expect(changeSet.risk).toBe("strong");
  });

  it("rejects targets outside the selected range", async () => {
    await expect(planSpreadsheetChangeSet({
      ctx, context: context(), message: "Write outside",
      planner: planner({ summary: "Bad target", operations: [{ type: "set_values", target: "F2", matrixJson: "[[1]]" }] }),
    })).rejects.toThrow("target_outside_selection");
  });

  it("rejects external formulas and malformed matrices", async () => {
    await expect(planSpreadsheetChangeSet({
      ctx, context: context(), message: "External formula",
      planner: planner({ summary: "Bad formula", operations: [{ type: "set_formulas", target: "D2", matrixJson: '[["=[other.xlsx]A1"]]' }] }),
    })).rejects.toThrow("external_formula_reference");
    await expect(planSpreadsheetChangeSet({
      ctx, context: context(), message: "Wrong shape",
      planner: planner({ summary: "Wrong shape", operations: [{ type: "set_values", target: "D2:E2", matrixJson: "[[1]]" }] }),
    })).rejects.toThrow("matrix_dimensions_mismatch");
    await expect(planSpreadsheetChangeSet({
      ctx, context: context(), message: "Null is not a clear operation",
      planner: planner({ summary: "Bad clear", operations: [{ type: "set_values", target: "D2", matrixJson: "[[null]]" }] }),
    })).rejects.toThrow("null_cell_value_not_allowed");
  });

  it("keeps planning disabled when the signed client capability is false", async () => {
    await expect(planSpreadsheetChangeSet({
      ctx, context: context(false), message: "Change a value",
      planner: planner({ summary: "Change", operations: [{ type: "set_values", target: "D2", matrixJson: "[[1]]" }] }),
    })).rejects.toThrow("spreadsheet_writes_not_enabled");
  });
});
