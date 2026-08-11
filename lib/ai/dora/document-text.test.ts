import { describe, expect, it, vi } from "vitest";

vi.mock("../db/collections.ts", () => ({ getAiCollections: vi.fn() }));
vi.mock("../../storage/s3.ts", () => ({
  createDownloadUrl: vi.fn(),
  getObjectBuffer: vi.fn(),
}));
vi.mock("../../onlyoffice/conversion.ts", () => ({ requestConversion: vi.fn() }));
vi.mock("../../onlyoffice/callback.ts", () => ({
  normalizeOnlyOfficeDownloadUrl: vi.fn((url: string) => url),
}));
vi.mock("../../onlyoffice/env.ts", () => ({ onlyOfficeEnabled: vi.fn(() => true) }));

const { workspaceTextCacheKey } = await import("./document-text.ts");

describe("workspace text cache key", () => {
  // Cache rows are keyed by this exact string (idempotency-key convention of
  // ai_index_state); a format change strands existing rows as dead weight.
  it("format is frozen: wdoc:{documentId}:{sha256}", () => {
    expect(workspaceTextCacheKey("64a000000000000000000001", "abc123")).toBe(
      "wdoc:64a000000000000000000001:abc123",
    );
  });
});
