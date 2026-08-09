import type { ChatCitation } from "../agent/citations.ts";
import type { ReportLabels } from "./labels.ts";
import type { SerializedTenderReport } from "./service.ts";
import type { TenderReportContent } from "./schema.ts";

/**
 * Print-ready HTML for one tender report. This is the PDF's source document —
 * Chromium prints exactly this — so it is deliberately self-contained: no
 * external stylesheet, no web font, no script. It is NOT the on-screen page
 * (that is a React component); the two share the data and the labels, not the
 * markup, because a paginated document and a scrolling page want different
 * layouts.
 */

/** Matches `--color-primary` in app/globals.css. */
const ACCENT = "#5000a8";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Model prose uses \n\n for paragraph breaks; nothing else is markup. */
function paragraphs(text: string | null | undefined): string {
  if (!text?.trim()) return "";
  return text
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function list(items: string[]): string {
  if (items.length === 0) return "";
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function citationRefs(ids: string[], citations: Record<string, ChatCitation>): string {
  const known = ids.filter((id) => citations[id]);
  if (known.length === 0) return "";
  return ` <span class="cite">[${known.map(escapeHtml).join(", ")}]</span>`;
}

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return escapeHtml(iso);
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

function formatDateTime(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return escapeHtml(iso);
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatMoney(
  value: { amount: string | null; currency: string | null } | null,
  locale: string,
  fallback: string,
): string {
  if (!value?.amount) return fallback;
  const numeric = Number(value.amount);
  if (!Number.isFinite(numeric)) return escapeHtml(value.amount);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: value.currency || "EUR",
      maximumFractionDigits: 0,
    }).format(numeric);
  } catch {
    return `${numeric.toLocaleString(locale)} ${value.currency ?? ""}`.trim();
  }
}

function section(heading: string, body: string): string {
  if (!body.trim()) return "";
  return `<section><h2>${escapeHtml(heading)}</h2>${body}</section>`;
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "";
  return [
    '<table><thead><tr>',
    headers.map((header) => `<th>${escapeHtml(header)}</th>`).join(""),
    "</tr></thead><tbody>",
    rows
      .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
      .join(""),
    "</tbody></table>",
  ].join("");
}

function scoreRow(label: string, value: number, hint?: string): string {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return `<div class="score"><span class="score-label">${escapeHtml(label)}${
    hint ? ` <em>(${escapeHtml(hint)})</em>` : ""
  }</span><span class="bar"><span style="width:${percent}%"></span></span><span class="score-value">${percent}%</span></div>`;
}

const STYLES = `
  @page { size: A4; margin: 18mm 16mm 20mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
    font-size: 10.5pt; line-height: 1.55; color: #1c1e24; margin: 0;
  }
  h1 { font-size: 20pt; line-height: 1.2; margin: 0 0 6pt; }
  h2 {
    font-size: 12.5pt; margin: 20pt 0 7pt; padding-bottom: 4pt;
    border-bottom: 1.5px solid ${ACCENT}; color: ${ACCENT};
    break-after: avoid; page-break-after: avoid;
  }
  h3 { font-size: 10.5pt; margin: 12pt 0 4pt; break-after: avoid; page-break-after: avoid; }
  p { margin: 0 0 7pt; }
  ul { margin: 0 0 8pt; padding-left: 15pt; }
  li { margin-bottom: 3pt; }
  section { break-inside: auto; }
  .cover { border-bottom: 2px solid ${ACCENT}; padding-bottom: 12pt; margin-bottom: 6pt; }
  .eyebrow {
    font-size: 8pt; letter-spacing: .14em; text-transform: uppercase;
    color: ${ACCENT}; font-weight: 700; margin-bottom: 6pt;
  }
  .meta { font-size: 9pt; color: #55585f; margin-top: 8pt; }
  .meta div { margin-bottom: 2pt; }
  .meta strong { color: #1c1e24; font-weight: 600; }
  .verdict {
    display: inline-block; padding: 5pt 11pt; border-radius: 4pt;
    font-weight: 700; font-size: 11pt; margin-bottom: 8pt;
  }
  .verdict-bid { background: #e9f9f3; color: #10704b; }
  .verdict-conditional { background: #fff4ec; color: #9a4a12; }
  .verdict-no_bid { background: #fff0ed; color: #a02718; }
  .stale {
    background: #fff8e6; border: 1px solid #e8c96a; color: #7a5a10;
    padding: 6pt 9pt; border-radius: 4pt; font-size: 9pt; margin-bottom: 10pt;
  }
  table { width: 100%; border-collapse: collapse; margin: 0 0 10pt; font-size: 9pt; }
  th {
    text-align: left; background: #f3f4f8; border-bottom: 1px solid #d7dae3;
    padding: 5pt 6pt; font-weight: 600;
  }
  td { border-bottom: 1px solid #e6e8ef; padding: 5pt 6pt; vertical-align: top; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  .cite { color: ${ACCENT}; font-size: 8pt; font-weight: 600; }
  .score { display: flex; align-items: center; gap: 8pt; margin-bottom: 4pt; font-size: 9pt; }
  .score-label { width: 46%; }
  .score-label em { color: #7a7d85; font-style: normal; font-size: 8pt; }
  .bar { flex: 1; height: 6pt; background: #e9ebf2; border-radius: 3pt; overflow: hidden; }
  .bar span { display: block; height: 100%; background: ${ACCENT}; }
  .score-value { width: 32pt; text-align: right; font-variant-numeric: tabular-nums; }
  .pill {
    display: inline-block; padding: 1pt 5pt; border-radius: 8pt;
    font-size: 8pt; font-weight: 600; white-space: nowrap;
  }
  .pill-met { background: #e9f9f3; color: #10704b; }
  .pill-partial { background: #fff4ec; color: #9a4a12; }
  .pill-gap { background: #fff0ed; color: #a02718; }
  .pill-unknown { background: #eef0f5; color: #5c6069; }
  .pill-high { background: #fff0ed; color: #a02718; }
  .pill-medium { background: #fff4ec; color: #9a4a12; }
  .pill-low { background: #eef0f5; color: #5c6069; }
  .critical { color: #a02718; font-weight: 600; }
  .gaps { background: #f8f9fc; border-left: 3px solid #c9cddb; padding: 8pt 10pt; }
  .sources { font-size: 8pt; color: #55585f; }
  .sources div { margin-bottom: 4pt; break-inside: avoid; }
  .sources q { color: #35383f; }
  .footnote {
    margin-top: 18pt; padding-top: 8pt; border-top: 1px solid #e0e2ea;
    font-size: 8pt; color: #7a7d85;
  }
`;

export function renderReportHtml(input: {
  data: SerializedTenderReport;
  labels: ReportLabels;
  locale: string;
}): string {
  const { labels, locale } = input;
  const data = input.data;
  const report = data.report as TenderReportContent;
  const citations = data.citations ?? {};

  const cover = [
    '<header class="cover">',
    `<div class="eyebrow">${escapeHtml(labels.documentTitle)}</div>`,
    `<h1>${escapeHtml(data.tender.title ?? "—")}</h1>`,
    '<div class="meta">',
    `<div><strong>${escapeHtml(labels.buyer)}:</strong> ${escapeHtml(data.tender.buyerName ?? "—")}</div>`,
    `<div><strong>${escapeHtml(labels.deadline)}:</strong> ${formatDateTime(data.tender.submissionDeadline, locale)}</div>`,
    `<div><strong>${escapeHtml(labels.estimatedValue)}:</strong> ${formatMoney(data.tender.estimatedValue, locale, labels.notProvided)}</div>`,
    `<div><strong>${escapeHtml(labels.procedure)}:</strong> ${escapeHtml(data.tender.procedureType ?? "—")}</div>`,
    data.companyName
      ? `<div><strong>${escapeHtml(labels.preparedFor)}:</strong> ${escapeHtml(data.companyName)}</div>`
      : "",
    `<div><strong>${escapeHtml(labels.generatedAt)}:</strong> ${formatDateTime(data.generatedAt, locale)} · ${escapeHtml(data.model.providerModel)}</div>`,
    "</div></header>",
  ].join("");

  const staleBanner = data.stale
    ? `<div class="stale">${escapeHtml(labels.staleWarning)}</div>`
    : "";

  const recommendationBody = [
    `<div class="verdict verdict-${report.recommendation.decision}">${escapeHtml(
      labels.recommendation.decision[report.recommendation.decision],
    )} · ${Math.round(report.recommendation.confidence * 100)}% ${escapeHtml(labels.recommendation.confidence)}</div>`,
    paragraphs(report.recommendation.rationale),
    report.recommendation.conditions.length
      ? `<h3>${escapeHtml(labels.recommendation.conditions)}</h3>${list(report.recommendation.conditions)}`
      : "",
  ].join("");

  const scoresBody = [
    scoreRow(labels.scores.eligibilityFit, report.scores.eligibilityFit),
    scoreRow(labels.scores.technicalFit, report.scores.technicalFit),
    scoreRow(labels.scores.capacityFit, report.scores.capacityFit),
    scoreRow(
      labels.scores.commercialAttractiveness,
      report.scores.commercialAttractiveness,
    ),
    scoreRow(labels.scores.contractRisk, report.scores.contractRisk, labels.scores.riskHint),
    scoreRow(labels.scores.deadlineFeasibility, report.scores.deadlineFeasibility),
  ].join("");

  const overviewBody = [
    `<h3>${escapeHtml(labels.overview.purpose)}</h3>`,
    paragraphs(report.tenderOverview.purpose),
    `<h3>${escapeHtml(labels.overview.scope)}</h3>`,
    paragraphs(report.tenderOverview.scope),
    report.tenderOverview.lots.length
      ? [
          `<h3>${escapeHtml(labels.overview.lots)}</h3>`,
          table(
            [labels.overview.lots, labels.overview.scope, ""],
            report.tenderOverview.lots.map((lot) => [
              escapeHtml(lot.name),
              escapeHtml(lot.summary),
              `<span class="pill ${lot.relevantToCompany ? "pill-met" : "pill-unknown"}">${escapeHtml(
                lot.relevantToCompany ? labels.overview.relevant : labels.overview.notRelevant,
              )}</span>`,
            ]),
          ),
        ].join("")
      : "",
    `<h3>${escapeHtml(labels.overview.buyer)}</h3>`,
    paragraphs(report.tenderOverview.buyer),
    `<h3>${escapeHtml(labels.overview.procedure)}</h3>`,
    paragraphs(report.tenderOverview.procedure),
  ].join("");

  const keyFactsBody = table(
    ["", ""],
    report.keyFacts.map((fact) => [
      `<strong>${escapeHtml(fact.label)}</strong>`,
      `${escapeHtml(fact.value)}${fact.note ? `<br><span class="sources">${escapeHtml(fact.note)}</span>` : ""}`,
    ]),
  );

  const timelineBody = table(
    [labels.timeline.date, labels.timeline.event, labels.timeline.detail],
    report.timeline.map((entry) => [
      `${formatDate(entry.date, locale)}${entry.critical ? `<br><span class="critical">${escapeHtml(labels.timeline.critical)}</span>` : ""}`,
      escapeHtml(entry.label),
      escapeHtml(entry.detail),
    ]),
  );

  const requirementsBody = table(
    [
      labels.requirements.requirement,
      labels.requirements.category,
      labels.requirements.mandatory,
      labels.requirements.status,
      labels.requirements.evidence,
      labels.requirements.action,
    ],
    report.requirements.map((entry) => [
      `${escapeHtml(entry.requirement)}${citationRefs(entry.evidenceIds, citations)}`,
      escapeHtml(labels.requirements.categories[entry.category] ?? entry.category),
      entry.mandatory === null
        ? "—"
        : escapeHtml(
            entry.mandatory ? labels.requirements.mandatoryYes : labels.requirements.mandatoryNo,
          ),
      `<span class="pill pill-${entry.companyStatus}">${escapeHtml(
        labels.requirements.statuses[entry.companyStatus] ?? entry.companyStatus,
      )}</span>`,
      escapeHtml(entry.evidence),
      entry.action ? escapeHtml(entry.action) : "—",
    ]),
  );

  const commercialsBody = [
    `<h3>${escapeHtml(labels.commercials.valueAssessment)}</h3>`,
    paragraphs(report.commercials.valueAssessment),
    `<h3>${escapeHtml(labels.commercials.paymentTerms)}</h3>`,
    paragraphs(report.commercials.paymentTerms),
    `<h3>${escapeHtml(labels.commercials.retentionsAndSecurities)}</h3>`,
    paragraphs(report.commercials.retentionsAndSecurities),
    `<h3>${escapeHtml(labels.commercials.penalties)}</h3>`,
    paragraphs(report.commercials.penalties),
    report.commercials.priceRisks.length
      ? `<h3>${escapeHtml(labels.commercials.priceRisks)}</h3>${list(report.commercials.priceRisks)}`
      : "",
  ].join("");

  const citedList = (items: Array<{ text: string; evidenceIds: string[] }>): string =>
    items.length === 0
      ? ""
      : `<ul>${items
          .map(
            (item) =>
              `<li>${escapeHtml(item.text)}${citationRefs(item.evidenceIds, citations)}</li>`,
          )
          .join("")}</ul>`;

  const companyFitBody = [
    paragraphs(report.companyFit.summary),
    report.companyFit.strengths.length
      ? `<h3>${escapeHtml(labels.companyFit.strengths)}</h3>${citedList(report.companyFit.strengths)}`
      : "",
    report.companyFit.gaps.length
      ? `<h3>${escapeHtml(labels.companyFit.gaps)}</h3>${citedList(report.companyFit.gaps)}`
      : "",
    report.companyFit.differentiators.length
      ? `<h3>${escapeHtml(labels.companyFit.differentiators)}</h3>${list(report.companyFit.differentiators)}`
      : "",
    `<h3>${escapeHtml(labels.companyFit.capacity)}</h3>`,
    paragraphs(report.companyFit.capacityAssessment),
  ].join("");

  const risksBody = table(
    [
      labels.risks.risk,
      labels.risks.severity,
      labels.risks.likelihood,
      labels.risks.impact,
      labels.risks.mitigation,
    ],
    report.risks.map((risk) => [
      `<strong>${escapeHtml(risk.title)}</strong>${citationRefs(risk.evidenceIds, citations)}`,
      `<span class="pill pill-${risk.severity}">${escapeHtml(labels.risks.levels[risk.severity] ?? risk.severity)}</span>`,
      escapeHtml(labels.risks.levels[risk.likelihood] ?? risk.likelihood),
      escapeHtml(risk.impact),
      escapeHtml(risk.mitigation),
    ]),
  );

  const strategyBody = [
    report.bidStrategy.winThemes.length
      ? `<h3>${escapeHtml(labels.bidStrategy.winThemes)}</h3>${list(report.bidStrategy.winThemes)}`
      : "",
    `<h3>${escapeHtml(labels.bidStrategy.pricingApproach)}</h3>`,
    paragraphs(report.bidStrategy.pricingApproach),
    `<h3>${escapeHtml(labels.bidStrategy.partnering)}</h3>`,
    paragraphs(report.bidStrategy.partnering),
    `<h3>${escapeHtml(labels.bidStrategy.effortEstimate)}</h3>`,
    paragraphs(report.bidStrategy.effortEstimate),
  ].join("");

  const actionsBody = table(
    [
      labels.actionPlan.action,
      labels.actionPlan.priority,
      labels.actionPlan.dueBy,
      labels.actionPlan.rationale,
    ],
    report.actionPlan.map((entry) => [
      escapeHtml(entry.action),
      escapeHtml(labels.actionPlan.priorities[entry.priority] ?? entry.priority),
      formatDate(entry.dueBy, locale),
      escapeHtml(entry.rationale),
    ]),
  );

  const questionsBody = table(
    [labels.openQuestions.question, labels.openQuestions.whoToAsk, labels.openQuestions.why],
    report.openQuestions.map((entry) => [
      escapeHtml(entry.question),
      escapeHtml(entry.whoToAsk),
      escapeHtml(entry.why),
    ]),
  );

  const checklistBody = table(
    [labels.checklist.document, labels.checklist.source, labels.checklist.note],
    report.documentChecklist.map((entry) => [
      escapeHtml(entry.document),
      escapeHtml(labels.checklist.sources[entry.source] ?? entry.source),
      entry.note ? escapeHtml(entry.note) : "—",
    ]),
  );

  const sourcesBody = Object.entries(citations).length
    ? `<div class="sources">${Object.entries(citations)
        .map(
          ([id, citation]) =>
            `<div><strong>[${escapeHtml(id)}]</strong> ${escapeHtml(citation.fileName)} — <q>${escapeHtml(citation.quote)}</q></div>`,
        )
        .join("")}</div>`
    : "";

  const coverageBody = `<div class="sources">${[
    `${escapeHtml(labels.coverage.tenderExcerpts)}: ${data.coverage.tenderChunkCount}`,
    `${escapeHtml(labels.coverage.companyExcerpts)}: ${data.coverage.companyChunkCount}`,
    `${escapeHtml(labels.coverage.extractions)}: ${Object.keys(data.coverage.extractionStatuses).length}`,
    `${escapeHtml(labels.coverage.overviewUsed)}: ${escapeHtml(data.coverage.hasOverview ? labels.coverage.yes : labels.coverage.no)}`,
    `${escapeHtml(labels.coverage.fitUsed)}: ${escapeHtml(data.coverage.hasFit ? labels.coverage.yes : labels.coverage.no)}`,
    `${escapeHtml(labels.coverage.verdictUsed)}: ${escapeHtml(data.coverage.hasVerdict ? labels.coverage.yes : labels.coverage.no)}`,
  ].join(" · ")}</div>`;

  return [
    `<!doctype html><html lang="${escapeHtml(locale)}"><head><meta charset="utf-8">`,
    `<title>${escapeHtml(labels.documentTitle)} — ${escapeHtml(data.tender.title ?? "")}</title>`,
    `<style>${STYLES}</style></head><body>`,
    cover,
    staleBanner,
    section(labels.sections.executiveSummary, paragraphs(report.executiveSummary)),
    section(labels.sections.recommendation, recommendationBody),
    section(labels.sections.scores, scoresBody),
    section(labels.sections.overview, overviewBody),
    section(labels.sections.keyFacts, keyFactsBody),
    section(labels.sections.timeline, timelineBody),
    section(labels.sections.requirements, requirementsBody),
    section(labels.sections.commercials, commercialsBody),
    section(labels.sections.companyFit, companyFitBody),
    section(labels.sections.risks, risksBody),
    section(labels.sections.competition, paragraphs(report.competition)),
    section(labels.sections.bidStrategy, strategyBody),
    section(labels.sections.actionPlan, actionsBody),
    section(labels.sections.openQuestions, questionsBody),
    section(labels.sections.documentChecklist, checklistBody),
    report.dataGaps.length
      ? section(
          labels.sections.dataGaps,
          `<div class="gaps">${list(report.dataGaps)}</div>`,
        )
      : "",
    section(labels.sections.sources, sourcesBody),
    section(labels.sections.coverage, coverageBody),
    `<div class="footnote">${escapeHtml(labels.disclaimer)} · ${escapeHtml(labels.poweredBy)}</div>`,
    "</body></html>",
  ].join("");
}
