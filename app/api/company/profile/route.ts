import { NextResponse } from "next/server";

import { getCompanyContext } from "@/lib/company/context";
import { serializeCompanyProfile } from "@/lib/company/serialize";
import { createDownloadUrl } from "@/lib/storage/s3";
import { buildCompanyProfileUpdate } from "@/lib/validation/company-profile";

/** Resolves a presigned logo URL, swallowing storage errors so a missing/misconfigured bucket never breaks the profile read. */
async function resolveLogoUrl(logoKey?: string): Promise<string | null> {
  if (!logoKey) return null;
  try {
    const { downloadUrl } = await createDownloadUrl({ key: logoKey });
    return downloadUrl;
  } catch (error) {
    console.error("Failed to resolve company logo URL", error);
    return null;
  }
}

export async function GET() {
  const context = await getCompanyContext();
  if (!context)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const logoUrl = await resolveLogoUrl(context.company.logoKey);
  return NextResponse.json({
    company: serializeCompanyProfile(context.company, { logoUrl }),
  });
}

export async function PATCH(request: Request) {
  const context = await getCompanyContext({ requireAdmin: true });
  if (!context)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "Request body must be an object." },
      { status: 400 },
    );
  }

  const update = buildCompanyProfileUpdate(body);
  if (Object.keys(update).length === 0) {
    return NextResponse.json(
      { error: "No updatable company fields were provided." },
      { status: 400 },
    );
  }
  // `name` is required by the schema — reject a payload that would blank it.
  if ("name" in update && !update.name) {
    return NextResponse.json(
      { error: "Company name cannot be empty." },
      { status: 400 },
    );
  }

  context.company.set(update);
  await context.company.save();

  const logoUrl = await resolveLogoUrl(context.company.logoKey);
  return NextResponse.json({
    company: serializeCompanyProfile(context.company, { logoUrl }),
  });
}
