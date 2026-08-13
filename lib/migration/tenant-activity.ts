/**
 * Decides whether a tenant in the target database is actually being used.
 *
 * The migration needs this in two places and they must agree:
 *   - Phase 3 asks it before adopting a company that already exists, so it
 *     never overwrites a real customer's profile with legacy data.
 *   - The prune script asks it before deleting anything.
 *
 * The signals are deliberately behavioural rather than structural. A migrated
 * tenant has members and a profile but nobody has ever signed in; a real one has
 * someone who set a password, holds a session, or created something. Testing
 * "does it have members" cannot tell those apart — Phase 4 gives every migrated
 * company members too.
 */
import type { Db, ObjectId } from "mongodb";

export interface TenantActivity {
  /** Human-readable evidence that the company itself has been used. */
  companyEvidence: string[];
  /** Members who are real people, mapped to why we think so. */
  liveMembers: Map<string, string>;
  /** True when anything above found something. */
  inUse: boolean;
}

export async function inspectTenantActivity(
  database: Db,
  input: { companyId: ObjectId; memberUserIds: string[]; toObjectId: (hex: string) => ObjectId },
): Promise<TenantActivity> {
  const { companyId, memberUserIds, toObjectId } = input;
  const hexId = companyId.toHexString();

  const checks: Array<[string, Promise<number>]> = [
    [
      "tender decisions",
      // tender_decisions stores companyId as a hex string, not an ObjectId.
      database.collection("tender_decisions").countDocuments({ companyId: hexId }),
    ],
    ["company files", database.collection("companyfiles").countDocuments({ companyId })],
    ["chat threads", database.collection("chat_threads").countDocuments({ tenantId: companyId })],
    [
      "workspace documents",
      database.collection("workspacedocuments").countDocuments({ companyId }),
    ],
  ];

  const companyEvidence: string[] = [];
  for (const [label, pending] of checks) {
    const count = await pending;
    if (count > 0) companyEvidence.push(`${count} ${label}`);
  }

  const liveMembers = new Map<string, string>();
  if (memberUserIds.length > 0) {
    const objectIds = memberUserIds.map(toObjectId);

    const withPassword = await database
      .collection("account")
      .distinct("userId", { userId: { $in: objectIds } });
    for (const id of withPassword) liveMembers.set(String(id), "has set a password");

    const withSession = await database
      .collection("session")
      .distinct("userId", { userId: { $in: objectIds } });
    for (const id of withSession) {
      if (!liveMembers.has(String(id))) {
        liveMembers.set(String(id), "has an active session");
      }
    }
  }

  return {
    companyEvidence,
    liveMembers,
    inUse: companyEvidence.length > 0 || liveMembers.size > 0,
  };
}
