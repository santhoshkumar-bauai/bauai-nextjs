import { describe, expect, it } from "vitest";

import {
  editorRevisionAfterCallback,
  isValidOnlyOfficeKey,
  onlyOfficeDocumentKey,
} from "./key";

describe("ONLYOFFICE editor keys", () => {
  it("is stable, namespaced, and valid", () => {
    const key = onlyOfficeDocumentKey({ documentId: "abc/123", editorRevision: 4, environment: "preview branch" });
    expect(key).toBe("bau-preview-branch-abc-123-r4");
    expect(isValidOnlyOfficeKey(key)).toBe(true);
  });

  it("caps long keys at 128 characters", () => {
    const key = onlyOfficeDocumentKey({ documentId: "a".repeat(200), editorRevision: 1, environment: "prod" });
    expect(key).toHaveLength(128);
    expect(isValidOnlyOfficeKey(key)).toBe(true);
  });

  it("rotates only after final save, never after force-save", () => {
    expect(editorRevisionAfterCallback(7, 6)).toBe(7);
    expect(editorRevisionAfterCallback(7, 2)).toBe(8);
    expect(editorRevisionAfterCallback(7, 4)).toBe(7);
  });
});
