import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { locales, type Locale } from "@/i18n/config";
import { auth } from "@/lib/auth";
import { connectMongoose } from "@/lib/db/mongoose";
import { normalizeCompanyWebsite } from "@/lib/validation/company-website";
import { AccountProfile } from "@/models/account-profile";
import { Company, type CompanyMemberRole } from "@/models/company";

type OnboardingBody = {
  website?: unknown;
  businessDomain?: unknown;
  region?: unknown;
  services?: unknown;
  cpvCodes?: unknown;
  locale?: unknown;
};

const cleanList = (value: unknown) => Array.isArray(value)
  ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
  : [];

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!session.user.emailVerified) return NextResponse.json({ error: "Email verification required" }, { status: 403 });

  await connectMongoose();
  const existingProfile = await AccountProfile.findOne({ userId: session.user.id }).lean();
  if (existingProfile?.onboardingCompleted) {
    return NextResponse.json({ ok: true, companyId: existingProfile.companyId });
  }

  const body = await request.json() as OnboardingBody;
  const normalizedWebsite = typeof body.website === "string"
    ? normalizeCompanyWebsite(body.website)
    : null;
  const businessDomain = typeof body.businessDomain === "string" ? body.businessDomain.trim() : "";
  const region = typeof body.region === "string" ? body.region.trim() : "";
  const services = cleanList(body.services);
  const cpvCodes = cleanList(body.cpvCodes);
  const locale: Locale = locales.includes(body.locale as Locale) ? body.locale as Locale : "en";

  if (!normalizedWebsite || !businessDomain || !region || services.length === 0 || cpvCodes.length === 0) {
    return NextResponse.json({ error: "Please complete all required onboarding fields." }, { status: 400 });
  }

  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  let company = await Company.findOne({ domain: normalizedWebsite.domain });
  let role: CompanyMemberRole = "member";

  if (!company) {
    role = "admin";
    const companyName = normalizedWebsite.domain.split(".")[0]
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase());

    try {
      company = await Company.create({
        name: companyName,
        domain: normalizedWebsite.domain,
        website: normalizedWebsite.website,
        businessDomain,
        region,
        services,
        cpvCodes,
        members: [{ userId: session.user.id, email: session.user.email, role, joinedAt: now }],
        trial: { status: "active", startsAt: now, endsAt: trialEndsAt },
        createdBy: session.user.id,
      });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== 11000) throw error;
      company = await Company.findOne({ domain: normalizedWebsite.domain });
      role = "member";
    }
  }

  if (!company) return NextResponse.json({ error: "Unable to create company." }, { status: 500 });

  await Company.updateOne(
    { _id: company._id, "members.userId": { $ne: session.user.id } },
    { $push: { members: { userId: session.user.id, email: session.user.email, role, joinedAt: now } } },
  );

  const effectiveTrialStart = role === "admin" ? now : company.trial.startsAt;
  const effectiveTrialEnd = role === "admin" ? trialEndsAt : company.trial.endsAt;

  await AccountProfile.findOneAndUpdate(
    { userId: session.user.id },
    {
      $set: {
        email: session.user.email,
        companyId: company._id,
        role,
        onboardingCompleted: true,
        locale,
        trialStartsAt: effectiveTrialStart,
        trialEndsAt: effectiveTrialEnd,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return NextResponse.json({
    ok: true,
    companyId: company.id,
    role,
    trialEndsAt: effectiveTrialEnd,
  });
}
