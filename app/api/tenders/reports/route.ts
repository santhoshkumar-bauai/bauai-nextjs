import { NextResponse } from "next/server";

import { REPORT_LOCALES, type ReportLocale } from "@/lib/ai/report/schema";
import { listReportSummaries } from "@/lib/ai/report/service";
import { getCompanyContext } from "@/lib/company/context";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";

/**
 * Every full report this company has, as compact cards — what the chat
 * workspace lists. Never returns whole reports; those are tens of kilobytes
 * each and are fetched one at a time by the report page.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = await getCompanyContext();
  if (!context) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const requested = new URL(request.url).searchParams.get("locale");
  const locale = (REPORT_LOCALES as readonly string[]).includes(requested ?? "")
    ? (requested as ReportLocale)
    : (resolveRequestLocale(request) as ReportLocale);

  const reports = await listReportSummaries(context, locale);
  return NextResponse.json({ reports });
}
