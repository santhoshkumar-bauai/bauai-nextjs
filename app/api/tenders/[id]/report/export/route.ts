import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";

import { buildReportLabels } from "@/lib/ai/report/labels";
import { getReportState, serializeReport } from "@/lib/ai/report/service";
import { getCompanyContext } from "@/lib/company/context";
import { reportLocaleFromRequest } from "../locale";

/**
 * Downloads the stored report as PDF or DOCX. Both formats are rendered from
 * the SAME persisted structured report, so a PDF and a DOCX of one report can
 * never disagree — and neither can drift from the on-screen page.
 *
 * Never generates: export is a download action on an existing report. If none
 * exists the caller gets a 404 and the UI offers to generate first.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Keeps a tender title usable as a filename on every OS. */
function safeFileName(title: string | null, extension: string): string {
  const base = (title ?? "tender-report")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 70);
  return `${base || "tender-report"}.${extension}`;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await getCompanyContext();
  if (!context) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid tender id" }, { status: 400 });
  }

  const format = new URL(request.url).searchParams.get("format");
  if (format !== "pdf" && format !== "docx") {
    return NextResponse.json(
      { error: "format must be pdf or docx" },
      { status: 400 },
    );
  }

  const state = await getReportState(context, new ObjectId(id));
  // The export is always in the language the caller is reading, falling back
  // the same way the page does, so a downloaded file matches what was on
  // screen when the button was pressed.
  const requestedLocale = reportLocaleFromRequest(request);
  const data = state
    ? serializeReport(state.report, state.stale, requestedLocale)
    : null;
  if (!data) {
    return NextResponse.json(
      { error: "No report has been generated for this tender yet." },
      { status: 404 },
    );
  }

  const locale = data.locale;
  const labels = buildReportLabels(
    await getTranslations({ locale, namespace: "Tenders.report" }),
  );

  try {
    if (format === "docx") {
      const { renderReportDocx } = await import("@/lib/ai/report/render-docx");
      const buffer = await renderReportDocx({ data, labels, locale });
      return fileResponse(
        buffer,
        safeFileName(data.tender.title, "docx"),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
    }

    const [{ renderReportHtml }, { renderReportPdf, PdfUnavailableError }] =
      await Promise.all([
        import("@/lib/ai/report/render-html"),
        import("@/lib/ai/report/render-pdf"),
      ]);
    const html = renderReportHtml({ data, labels, locale });
    try {
      const buffer = await renderReportPdf({
        html,
        footerLeft: [labels.documentTitle, data.tender.title ?? ""]
          .filter(Boolean)
          .join(" — "),
        pageLabel: labels.page,
      });
      return fileResponse(
        buffer,
        safeFileName(data.tender.title, "pdf"),
        "application/pdf",
      );
    } catch (error) {
      if (error instanceof PdfUnavailableError) {
        return NextResponse.json({ error: error.message }, { status: 503 });
      }
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Export failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function fileResponse(
  buffer: Buffer,
  fileName: string,
  contentType: string,
): Response {
  // `filename*` carries the UTF-8 name; the ASCII `filename` is the fallback.
  const asciiName = fileName.replace(/[^\x20-\x7E]/g, "_");
  return new Response(new Uint8Array(buffer), {
    headers: {
      "content-type": contentType,
      "content-length": String(buffer.length),
      "content-disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "cache-control": "private, no-store",
    },
  });
}
