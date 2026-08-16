import { NextResponse } from "next/server";

import { corsHeadersFor, handlePreflight } from "@/lib/dora-gateway/cors";
import {
  bearerFromRequest,
  signDoraBearer,
  verifyDoraEditorGrant,
} from "@/lib/dora-gateway/tokens";
import { connectMongoose } from "@/lib/db/mongoose";
import { AccountProfile } from "@/models/account-profile";
import { Company } from "@/models/company";
import { WorkspaceDocument } from "@/models/workspace-document";

/**
 * Grant → bearer exchange for the editor panel. The grant arrives inside the
 * signed editor config (customization.dora.grant); possession is not enough —
 * membership and document ownership are re-validated against Mongo before a
 * bearer is minted, so a revoked user's 8h grant dies here.
 */

export function OPTIONS(request: Request) {
  return handlePreflight(request);
}

export async function POST(request: Request) {
  const cors = corsHeadersFor(request);
  if (!cors) return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });

  const grant = bearerFromRequest(request);
  if (!grant) {
    return NextResponse.json({ error: "missing_grant" }, { status: 401, headers: cors });
  }

  let claims;
  try {
    claims = await verifyDoraEditorGrant(grant);
  } catch {
    return NextResponse.json({ error: "invalid_grant" }, { status: 401, headers: cors });
  }

  await connectMongoose();
  const profile = await AccountProfile.findOne({
    userId: claims.userId,
    membershipStatus: "active",
  }).lean();
  const membershipOk =
    profile?.onboardingCompleted && String(profile.companyId) === claims.companyId;
  const company = membershipOk
    ? await Company.findOne({
        _id: claims.companyId,
        members: { $elemMatch: { userId: claims.userId } },
      }).lean()
    : null;
  const document = company
    ? await WorkspaceDocument.findOne({
        _id: claims.documentId,
        companyId: company._id,
        deletedAt: null,
      }).lean()
    : null;
  if (!document) {
    return NextResponse.json({ error: "grant_revoked" }, { status: 403, headers: cors });
  }

  const bearer = await signDoraBearer({
    userId: claims.userId,
    companyId: claims.companyId,
    documentId: claims.documentId,
    name: claims.name,
    email: claims.email,
  });
  return NextResponse.json(
    { token: bearer.token, expiresAt: bearer.expiresAt },
    { headers: cors },
  );
}
