import { describe, expect, it } from "vitest";

import {
  aiJobSchema,
  chunkEmbedJobId,
  docChunkJobId,
  noticeEmbedJobId,
  noticeEmbedJobSchema,
} from "./jobs.ts";

const tenderId = "6a75cb6069759cd96e3dd39d";
const sha = "a".repeat(64);

describe("idempotency keys", () => {
  it("is deterministic for the same identity", () => {
    const job = {
      tenderId,
      embeddingModel: "gemini-embedding-001",
      embeddingVersion: "2026-08",
    };
    expect(noticeEmbedJobId(job)).toBe(noticeEmbedJobId({ ...job }));
    expect(noticeEmbedJobId(job)).toBe(
      `embed:notice:${tenderId}:gemini-embedding-001:2026-08`,
    );
  });

  it("changes when the embedding version changes", () => {
    const v1 = noticeEmbedJobId({
      tenderId,
      embeddingModel: "m",
      embeddingVersion: "2026-08",
    });
    const v2 = noticeEmbedJobId({
      tenderId,
      embeddingModel: "m",
      embeddingVersion: "2026-09",
    });
    expect(v1).not.toBe(v2);
  });

  it("scopes chunk work to file identity and chunker version", () => {
    const key = docChunkJobId({
      documentRecordId: "proc:x#abc",
      fileSha256: sha,
      chunkerVersion: "v1",
    });
    expect(key).toBe(`chunk:doc:proc:x#abc:${sha}:v1`);
  });

  it("chunk embed key includes both chunker and embedding identity", () => {
    const key = chunkEmbedJobId({
      documentRecordId: "proc:x#abc",
      fileSha256: sha,
      chunkerVersion: "v1",
      embeddingModel: "m",
      embeddingVersion: "2026-08",
    });
    expect(key.endsWith(":v1:m:2026-08")).toBe(true);
  });
});

describe("payload validation", () => {
  it("accepts a valid notice embed job and defaults the system actor", () => {
    const parsed = noticeEmbedJobSchema.parse({
      kind: "notice_embed",
      tenderId,
      embeddingModel: "gemini-embedding-001",
      embeddingVersion: "2026-08",
      correlationId: "run-1",
    });
    expect(parsed.actorId).toBe("system");
    expect(parsed.attempt).toBe(0);
  });

  it("rejects an invalid tenderId", () => {
    expect(() =>
      noticeEmbedJobSchema.parse({
        kind: "notice_embed",
        tenderId: "not-an-objectid",
        embeddingModel: "m",
        embeddingVersion: "v",
        correlationId: "c",
      }),
    ).toThrow();
  });

  it("discriminates job kinds", () => {
    const parsed = aiJobSchema.parse({
      kind: "doc_chunks",
      documentRecordId: "proc:x#abc",
      tenderId,
      fileSha256: sha,
      chunkerVersion: "v1",
      correlationId: "c",
    });
    expect(parsed.kind).toBe("doc_chunks");
  });

  it("rejects an unknown kind", () => {
    expect(() => aiJobSchema.parse({ kind: "mystery" })).toThrow();
  });
});
