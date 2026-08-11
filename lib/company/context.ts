import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import { connectMongoose } from "@/lib/db/mongoose";
import { AccountProfile } from "@/models/account-profile";
import {
  Company,
  type CompanyDocument,
  type CompanyMemberRole,
} from "@/models/company";
import type { HydratedDocument } from "mongoose";

export type CompanyContext = {
  userId: string;
  name: string;
  email: string;
  role: CompanyMemberRole;
  company: HydratedDocument<CompanyDocument>;
};

/**
 * Resolves the authenticated user's active company membership. Returns null when
 * the request is unauthenticated, unverified, has no completed onboarding, or is
 * not an active member of the company — every company-details endpoint needs the
 * same gate, so it lives here rather than being re-inlined per route.
 *
 * Pass `requireAdmin` for mutations that only admins may perform.
 */
export async function getCompanyContext(options?: {
  requireAdmin?: boolean;
}): Promise<CompanyContext | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.emailVerified) return null;

  await connectMongoose();
  const profile = await AccountProfile.findOne({
    userId: session.user.id,
    membershipStatus: "active",
  }).lean();
  if (!profile?.onboardingCompleted) return null;

  const memberFilter = options?.requireAdmin
    ? { userId: session.user.id, role: "admin" as const }
    : { userId: session.user.id };
  const company = await Company.findOne({
    _id: profile.companyId,
    members: { $elemMatch: memberFilter },
  });
  if (!company) return null;

  const member = company.members.find(
    (item) => item.userId === session.user.id,
  );

  return {
    userId: session.user.id,
    name: session.user.name?.trim() || session.user.email.split("@")[0],
    email: session.user.email,
    role: member?.role ?? profile.role,
    company,
  };
}
