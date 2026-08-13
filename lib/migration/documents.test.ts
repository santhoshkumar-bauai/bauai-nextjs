import { describe, expect, it } from "vitest";

import {
  type LegacyDocumentRow,
  RELATIVE_PATH_BUCKET,
  classifyDocument,
  dedupePlannedFiles,
  parseStoragePath,
  planFile,
} from "./documents.ts";

function row(overrides: Partial<LegacyDocumentRow> = {}): LegacyDocumentRow {
  return {
    id: "doc-1",
    company_id: "c1",
    file_name: "Vergabeunterlagen.pdf",
    mime_type: "application/pdf",
    file_size: 12345,
    storage_path: "c1/ae5e89da-2025-460a-809b-7d28ff9485cb/Vergabeunterlagen.pdf",
    ...overrides,
  };
}

describe("parseStoragePath", () => {
  it("reads the bucket out of a stored public URL", () => {
    // 30 cohort rows use this form and they are the real company documents.
    expect(
      parseStoragePath(
        "https://ref.supabase.co/storage/v1/object/public/GAigentFiles/ac51e0e7/09ef3ee1/1402_BALINGEN.pdf",
      ),
    ).toEqual({
      bucket: "GAigentFiles",
      objectPath: "ac51e0e7/09ef3ee1/1402_BALINGEN.pdf",
    });
  });

  it("treats a bare path as living in the chat-attachments bucket", () => {
    // 1,019 cohort rows use this form; they are not in GAigentFiles.
    expect(parseStoragePath("c1/doc-id/eForm_16_20271.pdf")).toEqual({
      bucket: RELATIVE_PATH_BUCKET,
      objectPath: "c1/doc-id/eForm_16_20271.pdf",
    });
  });

  it("decodes percent-encoding and strips a query string", () => {
    expect(
      parseStoragePath(
        "https://ref.supabase.co/storage/v1/object/public/GAigentFiles/c1/Angebot%20Nr%201.pdf?token=x",
      )?.objectPath,
    ).toBe("c1/Angebot Nr 1.pdf");
  });

  it("rejects a folder, which the documents table contains", () => {
    // e.g. "b3b61109-.../dwg/" — a prefix, not an object.
    expect(parseStoragePath("b3b61109/dwg/")).toBeNull();
    expect(parseStoragePath(null)).toBeNull();
    expect(parseStoragePath("   ")).toBeNull();
  });
});

describe("classifyDocument", () => {
  it("treats XML as a tender artifact even under a company folder", () => {
    // 567 cohort rows are eForms notices the old system extracted text from.
    expect(classifyDocument(row({ mime_type: "application/xml", file_name: "tender-9cd70df7.xml" })))
      .toBe("tender-artifact");
    expect(classifyDocument(row({ mime_type: "text/xml" }))).toBe("tender-artifact");
    expect(classifyDocument(row({ mime_type: null, file_name: "notice.xml" }))).toBe(
      "tender-artifact",
    );
  });

  it("separates a profile upload from a chat attachment by bucket", () => {
    expect(
      classifyDocument(
        row({
          storage_path:
            "https://ref.supabase.co/storage/v1/object/public/GAigentFiles/c1/x/Referenz.pdf",
        }),
      ),
    ).toBe("company-document");
    expect(classifyDocument(row())).toBe("chat-attachment");
  });
});

describe("planFile", () => {
  it("plans a company document into the general category", () => {
    const planned = planFile(
      row({
        storage_path:
          "https://ref.supabase.co/storage/v1/object/public/GAigentFiles/c1/x/Referenz.pdf",
      }),
    )!;

    expect(planned.category).toBe("general");
    expect(planned.kind).toBe("company-document");
    expect(planned.ref.bucket).toBe("GAigentFiles");
    expect(planned.size).toBe(12345);
  });

  it("falls back to the filename in the object path", () => {
    const planned = planFile(
      row({ file_name: null, storage_path: "c1/doc-id/eForm_16_20271.pdf" }),
    )!;
    expect(planned.fileName).toBe("eForm_16_20271.pdf");
  });

  it("defaults a missing mime type rather than writing an empty content type", () => {
    expect(planFile(row({ mime_type: null }))!.contentType).toBe("application/octet-stream");
  });

  it("refuses a row with no company or no usable path", () => {
    expect(planFile(row({ company_id: null }))).toBeNull();
    expect(planFile(row({ storage_path: null }))).toBeNull();
  });
});

describe("dedupePlannedFiles", () => {
  it("collapses repeated extraction attempts on one object", () => {
    const files = [planFile(row({ id: "a" }))!, planFile(row({ id: "b" }))!];
    expect(dedupePlannedFiles(files)).toHaveLength(1);
  });

  it("keeps the same object for two different companies", () => {
    const files = [
      planFile(row({ id: "a", company_id: "c1" }))!,
      planFile(row({ id: "b", company_id: "c2" }))!,
    ];
    expect(dedupePlannedFiles(files)).toHaveLength(2);
  });
});
