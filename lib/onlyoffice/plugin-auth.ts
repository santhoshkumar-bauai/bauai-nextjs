import { connectMongoose } from "@/lib/db/mongoose";
import { AccountProfile } from "@/models/account-profile";
import { Company } from "@/models/company";
import { WorkspaceDocument } from "@/models/workspace-document";

export async function authorizePluginScope(scope: {
  userId: string;
  companyId: string;
  documentId: string;
}) {
  await connectMongoose();
  const [profile, company, document] = await Promise.all([
    AccountProfile.findOne({
      userId: scope.userId,
      companyId: scope.companyId,
      membershipStatus: "active",
      onboardingCompleted: true,
    }).lean(),
    Company.findOne({
      _id: scope.companyId,
      members: { $elemMatch: { userId: scope.userId } },
    }).lean(),
    WorkspaceDocument.findOne({
      _id: scope.documentId,
      companyId: scope.companyId,
      deletedAt: null,
    }),
  ]);
  return profile && company && document ? document : null;
}

export function pluginCorsHeaders(request: Request): HeadersInit | null {
  const configured = process.env.NEXT_PUBLIC_DS_URL;
  if (!configured) return null;
  const allowed = new URL(configured).origin;
  const origin = request.headers.get("origin");
  if (origin && origin !== allowed) return null;
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}
