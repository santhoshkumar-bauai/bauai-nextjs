import { createHash } from "node:crypto";

import type { ObjectId } from "mongodb";

import { getAiCollections } from "../db/collections.ts";
import type { CompanyContextInput } from "./company-context.ts";

/**
 * Deterministic identity of "everything the fit analysis can see about the
 * company": the profile fields the context builder uses plus the identities
 * of every embedded company document. A cached recommendation whose stored
 * hash differs is stale — company data changed since it was generated.
 */

/**
 * Key-sorted deep copy, with a cycle guard.
 *
 * `path` tracks the ANCESTORS of the current node, not every object seen, so a
 * value legitimately referenced twice still hashes normally — only a true
 * back-reference short-circuits. The guard exists because this walk once ran
 * off a Mongoose subdocument's parent pointer and took the whole request down
 * with a stack overflow; callers now hand over POJOs
 * (`companyProfileInput`), but a hash function must never be the thing that
 * throws, so the belt stays on with the braces.
 */
function canonicalize(value: unknown, path = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, path));
  if (value && typeof value === "object") {
    if (path.has(value)) return "[circular]";
    path.add(value);
    const result = Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, canonicalize(v, path)]),
    );
    path.delete(value);
    return result;
  }
  return value;
}

export function hashCompanyData(
  profile: CompanyContextInput,
  embeddedDocs: Array<{ documentRecordId: string; fileSha256: string }>,
): string {
  const identity = {
    profile: canonicalize(profile),
    embeddedDocs: embeddedDocs
      .map((doc) => `${doc.documentRecordId}:${doc.fileSha256}`)
      .sort(),
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

/** Embedded-doc identities of a tenant's company corpus. */
export async function listEmbeddedCompanyDocs(
  tenantId: ObjectId,
): Promise<Array<{ documentRecordId: string; fileSha256: string }>> {
  const { chunks } = await getAiCollections();
  const rows = await chunks
    .aggregate<{ _id: { documentRecordId: string; fileSha256: string } }>([
      { $match: { tenantId } },
      {
        $group: {
          _id: { documentRecordId: "$documentRecordId", fileSha256: "$fileSha256" },
        },
      },
    ])
    .toArray();
  return rows.map((row) => row._id);
}
