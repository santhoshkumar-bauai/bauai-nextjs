import type { HydratedDocument } from "mongoose";

import { connectMongoose } from "@/lib/db/mongoose";
import type { CompanyContext } from "@/lib/company/context";
import { AccountProfile } from "@/models/account-profile";
import { Company, type CompanyDocument } from "@/models/company";

import { bearerFromRequest, verifyDoraBearer } from "./tokens";

/**
 * Bearer-authenticated counterpart of getCompanyContext() for editor-origin
 * requests (no cookies cross-origin). The bearer only names the identity —
 * membership, onboarding and company are re-validated against Mongo on every
 * call, exactly like the cookie path, and the bearer's documentId must match
 * the route's documentId so a token for one document cannot touch another.
 */

export type DoraGatewayAuth = {
  companyContext: CompanyContext;
  documentId: string;
};

export class DoraGatewayAuthError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
  }
}

export async function requireDoraGatewayAuth(
  request: Request,
  routeDocumentId: string,
): Promise<DoraGatewayAuth> {
  const token = bearerFromRequest(request);
  if (!token) throw new DoraGatewayAuthError(401, "missing_bearer");

  let claims;
  try {
    claims = await verifyDoraBearer(token);
  } catch {
    throw new DoraGatewayAuthError(401, "invalid_bearer");
  }
  if (claims.documentId !== routeDocumentId)
    throw new DoraGatewayAuthError(403, "document_mismatch");

  await connectMongoose();
  const profile = await AccountProfile.findOne({
    userId: claims.userId,
    membershipStatus: "active",
  }).lean();
  if (!profile?.onboardingCompleted || String(profile.companyId) !== claims.companyId)
    throw new DoraGatewayAuthError(403, "membership_revoked");

  const company: HydratedDocument<CompanyDocument> | null = await Company.findOne({
    _id: claims.companyId,
    members: { $elemMatch: { userId: claims.userId } },
  });
  if (!company) throw new DoraGatewayAuthError(403, "membership_revoked");

  const member = company.members.find((item) => item.userId === claims.userId);

  return {
    documentId: claims.documentId,
    companyContext: {
      userId: claims.userId,
      name: claims.name,
      email: claims.email,
      role: member?.role ?? profile.role,
      company,
    },
  };
}
