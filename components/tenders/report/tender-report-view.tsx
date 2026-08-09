"use client";

import {
  AlertTriangle,
  ArrowLeft,
  Download,
  FileText,
  Languages,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ReportProgress, ReportSkeleton } from "./report-progress";
import { useTenderReport } from "./use-tender-report";
import {
  Bullets,
  CitedBullets,
  Cites,
  DataTable,
  Prose,
  ScoreRow,
  Section,
  StatusPill,
  SubHeading,
} from "./report-primitives";

/**
 * The full tender report on its own page. Reads the cached report, generates
 * it on demand, and downloads it as PDF or DOCX — all three views (this page,
 * the PDF, the Word document) render the same persisted structured report.
 */

const DECISION_VARIANT = {
  bid: "success",
  conditional: "warning",
  no_bid: "danger",
} as const;

const SECTION_IDS = [
  "executiveSummary",
  "recommendation",
  "scores",
  "overview",
  "keyFacts",
  "timeline",
  "requirements",
  "commercials",
  "companyFit",
  "risks",
  "competition",
  "bidStrategy",
  "actionPlan",
  "openQuestions",
  "documentChecklist",
  "dataGaps",
  "sources",
] as const;

export function TenderReportView({ tenderId }: { tenderId: string }) {
  const t = useTranslations("Tenders.report");
  const format = useFormatter();
  // The report is stored per language; ask for exactly the one being rendered
  // rather than relying on the cookie, which lags a just-switched locale.
  const locale = useLocale();

  const { data, loading, error, generate, generating, stage } =
    useTenderReport(tenderId);

  const [exporting, setExporting] = useState<"pdf" | "docx" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const download = useCallback(
    async (fileFormat: "pdf" | "docx") => {
      setExporting(fileFormat);
      setExportError(null);
      try {
        const response = await fetch(
          `/api/tenders/${tenderId}/report/export?format=${fileFormat}&locale=${locale}`,
        );
        if (!response.ok) {
          const json = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          setExportError(json.error || t("exportError"));
          return;
        }
        // Filename comes from the server's content-disposition; the anchor
        // trick is the only way to name a blob download.
        const disposition = response.headers.get("content-disposition") ?? "";
        const match = /filename\*=UTF-8''([^;]+)/.exec(disposition);
        const fileName = match
          ? decodeURIComponent(match[1])
          : `tender-report.${fileFormat}`;
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
      } catch {
        setExportError(t("exportError"));
      } finally {
        setExporting(null);
      }
    },
    [tenderId, locale, t],
  );

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6">
        <div className="flex flex-col gap-4">
          <div className="h-8 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-40 w-full animate-pulse rounded-xl bg-muted" />
          <div className="h-64 w-full animate-pulse rounded-xl bg-muted" />
        </div>
      </div>
    );
  }

  // Generating with nothing on screen yet: the progress card IS the page.
  if (!data && generating) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8 sm:px-6">
        <BackLink tenderId={tenderId} label={t("back")} />
        <ReportProgress stage={stage} />
        <ReportSkeleton />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8 sm:px-6">
        <BackLink tenderId={tenderId} label={t("back")} />
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border bg-muted/20 px-6 py-16 text-center">
          <FileText className="size-7 text-primary" />
          <p className="text-sm font-medium text-foreground">{t("emptyTitle")}</p>
          <p className="max-w-md text-xs text-muted-foreground">
            {t("emptyDescription")}
          </p>
          <button
            type="button"
            onClick={generate}
            className="mt-2 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Sparkles className="size-4" />
            {t("generate")}
          </button>
          <p className="max-w-md text-[11px] text-muted-foreground/80">
            {t("takesAWhile")}
          </p>
          {error && <p className="text-xs text-rose-600">{error}</p>}
        </div>
      </div>
    );
  }

  const report = data.report;
  const citations = data.citations ?? {};

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <BackLink tenderId={tenderId} label={t("back")} />

      <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-start">
        {/* Contents rail — sticky on wide screens, hidden on small ones. */}
        <nav className="hidden w-52 shrink-0 lg:sticky lg:top-8 lg:block">
          <p className="mb-2 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
            {t("contents")}
          </p>
          <ul className="flex flex-col gap-0.5 text-xs">
            {SECTION_IDS.map((id) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className="block rounded px-2 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {t(`sections.${id}` as "sections.risks")}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <article className="min-w-0 flex-1 rounded-2xl border border-border bg-card px-5 py-6 shadow-xs sm:px-8 sm:py-8">
          <header className="flex flex-col gap-3 pb-6">
            <p className="text-[10px] font-semibold tracking-[0.14em] text-primary uppercase">
              {t("documentTitle")}
            </p>
            <h1 className="text-xl font-semibold text-foreground sm:text-2xl">
              {data.tender.title ?? "—"}
            </h1>
            <dl className="grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
              <MetaRow label={t("buyer")} value={data.tender.buyerName ?? "—"} />
              <MetaRow
                label={t("deadline")}
                value={
                  data.tender.submissionDeadline
                    ? format.dateTime(new Date(data.tender.submissionDeadline), {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })
                    : "—"
                }
              />
              <MetaRow
                label={t("procedure")}
                value={data.tender.procedureType ?? "—"}
              />
              <MetaRow
                label={t("generatedAt")}
                value={`${format.dateTime(new Date(data.generatedAt), {
                  dateStyle: "medium",
                  timeStyle: "short",
                })} · ${data.model.providerModel}`}
              />
            </dl>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => download("pdf")}
                disabled={exporting !== null}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
              >
                {exporting === "pdf" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Download className="size-3.5" />
                )}
                {t("exportPdf")}
              </button>
              <button
                type="button"
                onClick={() => download("docx")}
                disabled={exporting !== null}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
              >
                {exporting === "docx" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Download className="size-3.5" />
                )}
                {t("exportDocx")}
              </button>
              <button
                type="button"
                onClick={generate}
                disabled={generating}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                {generating ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                {generating ? t("generating") : t("regenerate")}
              </button>
            </div>
            {exportError && <p className="text-xs text-rose-600">{exportError}</p>}
            {error && <p className="text-xs text-rose-600">{error}</p>}

            {/* Regenerating over an existing report: keep the old one readable
                and show the progress inline rather than blanking the page. */}
            {generating && <ReportProgress stage={stage} />}

            {data.requestedLocale && (
              <p className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-[11px] text-muted-foreground">
                <Languages className="mt-px size-3.5 shrink-0" />
                {t("localeFallback", {
                  shown: t(`languages.${data.locale}` as "languages.en"),
                })}
              </p>
            )}

            {data.stale && (
              <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-800 ring-1 ring-inset ring-amber-600/20">
                <AlertTriangle className="mt-px size-3.5 shrink-0" />
                {t("staleWarning")}
              </p>
            )}
          </header>

          <div className="flex flex-col gap-6">
            <Section id="executiveSummary" title={t("sections.executiveSummary")}>
              <Prose text={report.executiveSummary} />
            </Section>

            <Section id="recommendation" title={t("sections.recommendation")}>
              <div className="flex flex-wrap items-center gap-3">
                <Badge
                  variant={DECISION_VARIANT[report.recommendation.decision]}
                  className="px-3 py-1 text-xs font-semibold"
                >
                  {t(
                    `recommendation.decision.${report.recommendation.decision}` as "recommendation.decision.bid",
                  )}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {Math.round(report.recommendation.confidence * 100)}%{" "}
                  {t("recommendation.confidence")}
                </span>
              </div>
              <Prose text={report.recommendation.rationale} />
              {report.recommendation.conditions.length > 0 && (
                <>
                  <SubHeading>{t("recommendation.conditions")}</SubHeading>
                  <Bullets items={report.recommendation.conditions} />
                </>
              )}
            </Section>

            <Section id="scores" title={t("sections.scores")}>
              <div className="flex flex-col gap-2">
                <ScoreRow
                  label={t("scores.eligibilityFit")}
                  value={report.scores.eligibilityFit}
                />
                <ScoreRow
                  label={t("scores.technicalFit")}
                  value={report.scores.technicalFit}
                />
                <ScoreRow
                  label={t("scores.capacityFit")}
                  value={report.scores.capacityFit}
                />
                <ScoreRow
                  label={t("scores.commercialAttractiveness")}
                  value={report.scores.commercialAttractiveness}
                />
                <ScoreRow
                  label={t("scores.contractRisk")}
                  value={report.scores.contractRisk}
                  hint={t("scores.riskHint")}
                  inverted
                />
                <ScoreRow
                  label={t("scores.deadlineFeasibility")}
                  value={report.scores.deadlineFeasibility}
                />
              </div>
            </Section>

            <Section id="overview" title={t("sections.overview")}>
              <SubHeading>{t("overview.purpose")}</SubHeading>
              <Prose text={report.tenderOverview.purpose} />
              <SubHeading>{t("overview.scope")}</SubHeading>
              <Prose text={report.tenderOverview.scope} />
              {report.tenderOverview.lots.length > 0 && (
                <>
                  <SubHeading>{t("overview.lots")}</SubHeading>
                  <DataTable
                    headers={[t("overview.lots"), t("overview.scope"), ""]}
                    rows={report.tenderOverview.lots.map((lot) => [
                      <span key="n" className="font-medium">
                        {lot.name}
                      </span>,
                      lot.summary,
                      <StatusPill
                        key="r"
                        status={lot.relevantToCompany ? "met" : "unknown"}
                        label={
                          lot.relevantToCompany
                            ? t("overview.relevant")
                            : t("overview.notRelevant")
                        }
                      />,
                    ])}
                  />
                </>
              )}
              <SubHeading>{t("overview.buyer")}</SubHeading>
              <Prose text={report.tenderOverview.buyer} />
              <SubHeading>{t("overview.procedure")}</SubHeading>
              <Prose text={report.tenderOverview.procedure} />
            </Section>

            <Section id="keyFacts" title={t("sections.keyFacts")}>
              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {report.keyFacts.map((fact, index) => (
                  <div key={index} className="flex flex-col border-b border-border/60 pb-2">
                    <dt className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                      {fact.label}
                    </dt>
                    <dd className="text-sm text-foreground">{fact.value}</dd>
                    {fact.note && (
                      <dd className="text-[11px] text-muted-foreground">{fact.note}</dd>
                    )}
                  </div>
                ))}
              </dl>
            </Section>

            <Section id="timeline" title={t("sections.timeline")}>
              <DataTable
                headers={[t("timeline.date"), t("timeline.event"), t("timeline.detail")]}
                rows={report.timeline.map((entry) => [
                  <span key="d" className="whitespace-nowrap">
                    {entry.date
                      ? format.dateTime(new Date(entry.date), { dateStyle: "medium" })
                      : "—"}
                    {entry.critical && (
                      <span className="block text-[10px] font-semibold text-rose-600">
                        {t("timeline.critical")}
                      </span>
                    )}
                  </span>,
                  <span key="l" className="font-medium">
                    {entry.label}
                  </span>,
                  entry.detail,
                ])}
              />
            </Section>

            <Section id="requirements" title={t("sections.requirements")}>
              <DataTable
                headers={[
                  t("requirements.requirement"),
                  t("requirements.category"),
                  t("requirements.mandatory"),
                  t("requirements.status"),
                  t("requirements.evidence"),
                  t("requirements.action"),
                ]}
                rows={report.requirements.map((entry) => [
                  <span key="r">
                    {entry.requirement}
                    <Cites ids={entry.evidenceIds} citations={citations} />
                  </span>,
                  t(
                    `requirements.categories.${entry.category}` as "requirements.categories.other",
                  ),
                  entry.mandatory === null
                    ? "—"
                    : entry.mandatory
                      ? t("requirements.mandatoryYes")
                      : t("requirements.mandatoryNo"),
                  <StatusPill
                    key="s"
                    status={entry.companyStatus}
                    label={t(
                      `requirements.statuses.${entry.companyStatus}` as "requirements.statuses.met",
                    )}
                  />,
                  entry.evidence,
                  entry.action ?? "—",
                ])}
              />
            </Section>

            <Section id="commercials" title={t("sections.commercials")}>
              <SubHeading>{t("commercials.valueAssessment")}</SubHeading>
              <Prose text={report.commercials.valueAssessment} />
              <SubHeading>{t("commercials.paymentTerms")}</SubHeading>
              <Prose text={report.commercials.paymentTerms} />
              <SubHeading>{t("commercials.retentionsAndSecurities")}</SubHeading>
              <Prose text={report.commercials.retentionsAndSecurities} />
              <SubHeading>{t("commercials.penalties")}</SubHeading>
              <Prose text={report.commercials.penalties} />
              {report.commercials.priceRisks.length > 0 && (
                <>
                  <SubHeading>{t("commercials.priceRisks")}</SubHeading>
                  <Bullets items={report.commercials.priceRisks} />
                </>
              )}
            </Section>

            <Section id="companyFit" title={t("sections.companyFit")}>
              <Prose text={report.companyFit.summary} />
              {report.companyFit.strengths.length > 0 && (
                <>
                  <SubHeading>{t("companyFit.strengths")}</SubHeading>
                  <CitedBullets items={report.companyFit.strengths} citations={citations} />
                </>
              )}
              {report.companyFit.gaps.length > 0 && (
                <>
                  <SubHeading>{t("companyFit.gaps")}</SubHeading>
                  <CitedBullets items={report.companyFit.gaps} citations={citations} />
                </>
              )}
              {report.companyFit.differentiators.length > 0 && (
                <>
                  <SubHeading>{t("companyFit.differentiators")}</SubHeading>
                  <Bullets items={report.companyFit.differentiators} />
                </>
              )}
              <SubHeading>{t("companyFit.capacity")}</SubHeading>
              <Prose text={report.companyFit.capacityAssessment} />
            </Section>

            <Section id="risks" title={t("sections.risks")}>
              <DataTable
                headers={[
                  t("risks.risk"),
                  t("risks.severity"),
                  t("risks.likelihood"),
                  t("risks.impact"),
                  t("risks.mitigation"),
                ]}
                rows={report.risks.map((risk) => [
                  <span key="t" className="font-medium">
                    {risk.title}
                    <Cites ids={risk.evidenceIds} citations={citations} />
                  </span>,
                  <StatusPill
                    key="s"
                    status={risk.severity}
                    label={t(`risks.levels.${risk.severity}` as "risks.levels.low")}
                  />,
                  t(`risks.levels.${risk.likelihood}` as "risks.levels.low"),
                  risk.impact,
                  risk.mitigation,
                ])}
              />
            </Section>

            <Section id="competition" title={t("sections.competition")}>
              <Prose text={report.competition} />
            </Section>

            <Section id="bidStrategy" title={t("sections.bidStrategy")}>
              {report.bidStrategy.winThemes.length > 0 && (
                <>
                  <SubHeading>{t("bidStrategy.winThemes")}</SubHeading>
                  <Bullets items={report.bidStrategy.winThemes} />
                </>
              )}
              <SubHeading>{t("bidStrategy.pricingApproach")}</SubHeading>
              <Prose text={report.bidStrategy.pricingApproach} />
              <SubHeading>{t("bidStrategy.partnering")}</SubHeading>
              <Prose text={report.bidStrategy.partnering} />
              <SubHeading>{t("bidStrategy.effortEstimate")}</SubHeading>
              <Prose text={report.bidStrategy.effortEstimate} />
            </Section>

            <Section id="actionPlan" title={t("sections.actionPlan")}>
              <DataTable
                headers={[
                  t("actionPlan.action"),
                  t("actionPlan.priority"),
                  t("actionPlan.dueBy"),
                  t("actionPlan.rationale"),
                ]}
                rows={report.actionPlan.map((entry) => [
                  <span key="a" className="font-medium">
                    {entry.action}
                  </span>,
                  <StatusPill
                    key="p"
                    status={
                      entry.priority === "immediate"
                        ? "high"
                        : entry.priority === "high"
                          ? "medium"
                          : "low"
                    }
                    label={t(
                      `actionPlan.priorities.${entry.priority}` as "actionPlan.priorities.normal",
                    )}
                  />,
                  entry.dueBy
                    ? format.dateTime(new Date(entry.dueBy), { dateStyle: "medium" })
                    : "—",
                  entry.rationale,
                ])}
              />
            </Section>

            <Section id="openQuestions" title={t("sections.openQuestions")}>
              <DataTable
                headers={[
                  t("openQuestions.question"),
                  t("openQuestions.whoToAsk"),
                  t("openQuestions.why"),
                ]}
                rows={report.openQuestions.map((entry) => [
                  entry.question,
                  entry.whoToAsk,
                  entry.why,
                ])}
              />
            </Section>

            <Section id="documentChecklist" title={t("sections.documentChecklist")}>
              <DataTable
                headers={[t("checklist.document"), t("checklist.source"), t("checklist.note")]}
                rows={report.documentChecklist.map((entry) => [
                  <span key="d" className="font-medium">
                    {entry.document}
                  </span>,
                  t(`checklist.sources.${entry.source}` as "checklist.sources.unknown"),
                  entry.note ?? "—",
                ])}
              />
            </Section>

            {report.dataGaps.length > 0 && (
              <Section id="dataGaps" title={t("sections.dataGaps")}>
                <div className="rounded-lg border-l-2 border-border bg-muted/30 px-4 py-3">
                  <Bullets items={report.dataGaps} />
                </div>
              </Section>
            )}

            <Section id="sources" title={t("sections.sources")}>
              <ul className="flex flex-col gap-2 text-[11px] text-muted-foreground">
                {Object.entries(citations).map(([id, citation]) => (
                  <li key={id} className="flex gap-2">
                    <span className="shrink-0 font-mono font-semibold text-primary">
                      [{id}]
                    </span>
                    <span>
                      <span className="font-medium text-foreground/80">
                        {citation.fileName}
                      </span>{" "}
                      — <q className="italic">{citation.quote}</q>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-muted-foreground/80">
                {[
                  `${t("coverage.tenderExcerpts")}: ${data.coverage.tenderChunkCount}`,
                  `${t("coverage.companyExcerpts")}: ${data.coverage.companyChunkCount}`,
                  `${t("coverage.extractions")}: ${Object.keys(data.coverage.extractionStatuses).length}`,
                ].join(" · ")}
              </p>
            </Section>

            <p className="border-t border-border pt-4 text-[11px] text-muted-foreground">
              {t("disclaimer")}
            </p>
          </div>
        </article>
      </div>
    </div>
  );
}

function BackLink({ tenderId, label }: { tenderId: string; label: string }) {
  return (
    <Link
      href={`/tenders/${tenderId}`}
      className={cn(
        "inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground",
        "transition-colors hover:text-foreground",
      )}
    >
      <ArrowLeft className="size-3.5" />
      {label}
    </Link>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <dt className="font-medium text-foreground/70">{label}:</dt>
      <dd className="min-w-0 truncate">{value}</dd>
    </div>
  );
}
