import { createHash, type Hash } from "node:crypto";

export function sha256(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Incremental hasher so archives can be checksummed while streaming (§5.1). */
export function createSha256Stream(): { update(chunk: Buffer): void; digest(): string } {
  const hash: Hash = createHash("sha256");
  return {
    update: (chunk) => void hash.update(chunk),
    digest: () => hash.digest("hex"),
  };
}

/** Short stable hash for cache keys and canonical fallbacks. */
export function shortHash(input: string, length = 16): string {
  return sha256(input).slice(0, length);
}
