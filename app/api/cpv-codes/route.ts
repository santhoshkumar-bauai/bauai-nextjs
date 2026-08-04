import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { connectMongoose } from "@/lib/db/mongoose";
import { CpvCode } from "@/models/cpv-code";

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.emailVerified) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim().slice(0, 80) || "";
  const locale = searchParams.get("locale") === "de" ? "de" : "en";
  const domain = searchParams.get("domain")?.trim().toUpperCase() || "";

  await connectMongoose();
  const filter: Record<string, unknown> = {};
  if (query) {
    const regex = new RegExp(escapeRegex(query), "i");
    filter.$or = [
      { code: regex },
      { "name.en": regex },
      { "name.de": regex },
      { keywords: regex },
    ];
  } else if (domain) {
    filter.categories = domain;
  }

  const results = await CpvCode.find(filter)
    .sort({ code: 1 })
    .limit(20)
    .select({ _id: 0, code: 1, name: 1 })
    .lean();

  return NextResponse.json({
    items: results.map((item) => ({
      value: item.code,
      label: `${item.code} - ${locale === "de" ? item.name.de : item.name.en}`,
    })),
  });
}
