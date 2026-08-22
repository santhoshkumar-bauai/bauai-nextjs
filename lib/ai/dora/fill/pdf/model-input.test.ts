import { afterEach, describe, expect, it } from "vitest";

import { pdfFileBlock, shouldSendPdfNatively } from "./model-input";

const ENV_KEYS = ["PDF_FILL_NATIVE_MAX_BYTES", "PDF_FILL_NATIVE_ALWAYS"] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("pdfFileBlock", () => {
  it("emits exactly the LangChain standard base64 file block", () => {
    // Must stay identical to what resolveMediaParts produces in
    // lib/ai/agent/attachments.ts — that shape is what the provider adapters
    // convert to their own document input, and it is proven in production.
    const block = pdfFileBlock(Buffer.from("hello"), "eigenerklaerung.pdf") as unknown as Record<
      string,
      unknown
    >;
    expect(Object.keys(block).sort()).toEqual([
      "data",
      "metadata",
      "mime_type",
      "source_type",
      "type",
    ]);
    expect(block.type).toBe("file");
    expect(block.source_type).toBe("base64");
    expect(block.mime_type).toBe("application/pdf");
    expect(block.data).toBe(Buffer.from("hello").toString("base64"));
    expect(block.metadata).toEqual({ filename: "eigenerklaerung.pdf" });
  });
});

describe("shouldSendPdfNatively", () => {
  const MB = 1024 * 1024;

  it("attaches the file by default for every class", () => {
    for (const documentClass of ["acroform", "digital", "scanned"] as const) {
      expect(shouldSendPdfNatively({ bytes: MB, documentClass }), documentClass).toBe(true);
    }
  });

  it("can be restricted to scans only", () => {
    process.env.PDF_FILL_NATIVE_ALWAYS = "false";
    expect(shouldSendPdfNatively({ bytes: MB, documentClass: "digital" })).toBe(false);
    // A scan has no text layer, so the pixels are the only signal — the switch
    // must not be able to turn them off.
    expect(shouldSendPdfNatively({ bytes: MB, documentClass: "scanned" })).toBe(true);
  });

  it("falls back to the manifest for an oversized digital PDF", () => {
    expect(shouldSendPdfNatively({ bytes: 9 * MB, documentClass: "digital" })).toBe(false);
  });

  it("fails loudly for an oversized scan instead of discovering nothing", () => {
    // Silently returning false here would run discovery against an empty
    // manifest and report "no fields found" for a perfectly good document.
    expect(() => shouldSendPdfNatively({ bytes: 9 * MB, documentClass: "scanned" })).toThrow(
      "pdf_too_large_for_vision",
    );
  });

  it("honours a configured size cap", () => {
    process.env.PDF_FILL_NATIVE_MAX_BYTES = String(2 * MB);
    expect(shouldSendPdfNatively({ bytes: MB, documentClass: "digital" })).toBe(true);
    expect(shouldSendPdfNatively({ bytes: 3 * MB, documentClass: "digital" })).toBe(false);
  });
});
