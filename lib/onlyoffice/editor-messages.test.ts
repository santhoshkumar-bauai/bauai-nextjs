import { describe, expect, it } from "vitest";

import {
  generatedDocumentIdFromEditorMessage,
  OPEN_GENERATED_DOCUMENT_MESSAGE,
} from "./editor-messages";

describe("ONLYOFFICE host messages", () => {
  it("accepts the generated-document navigation message", () => {
    expect(
      generatedDocumentIdFromEditorMessage({
        type: OPEN_GENERATED_DOCUMENT_MESSAGE,
        documentId: "6a8828f1bb09659d5f160639",
      }),
    ).toBe("6a8828f1bb09659d5f160639");
  });

  it.each([
    null,
    "6a8828f1bb09659d5f160639",
    { type: "other", documentId: "6a8828f1bb09659d5f160639" },
    { type: OPEN_GENERATED_DOCUMENT_MESSAGE, documentId: "../admin" },
    { type: OPEN_GENERATED_DOCUMENT_MESSAGE, documentId: 123 },
  ])("rejects malformed or unrelated values", (value) => {
    expect(generatedDocumentIdFromEditorMessage(value)).toBeNull();
  });
});
