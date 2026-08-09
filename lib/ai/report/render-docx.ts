import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

import type { ChatCitation } from "../agent/citations.ts";
import type { ReportLabels } from "./labels.ts";
import type { TenderReportContent } from "./schema.ts";
import type { SerializedTenderReport } from "./service.ts";

/**
 * The same report as a real .docx — an editable working document, which is the
 * point: bid teams paste sections of it into their own submission templates.
 * Built from the stored structured report, not from the HTML, so Word gets
 * genuine headings, tables and lists rather than converted markup.
 */

/** Matches `--color-primary` in app/globals.css. */
const ACCENT = "5000A8";
const MUTED = "6A6D74";
const BORDER = "E0E2EA";

const STATUS_SHADING: Record<string, string> = {
  met: "E9F9F3",
  partial: "FFF4EC",
  gap: "FFF0ED",
  unknown: "EEF0F5",
  high: "FFF0ED",
  medium: "FFF4EC",
  low: "EEF0F5",
};

function heading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 320, after: 140 },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 8, color: ACCENT, space: 4 },
    },
    children: [new TextRun({ text, bold: true, size: 26, color: ACCENT })],
  });
}

function subHeading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text, bold: true, size: 22 })],
  });
}

/** Model prose uses \n\n for paragraph breaks. */
function prose(text: string | null | undefined): Paragraph[] {
  if (!text?.trim()) return [];
  return text
    .split(/\n{2,}/)
    .map(
      (block) =>
        new Paragraph({
          spacing: { after: 120 },
          children: [new TextRun({ text: block.trim(), size: 20 })],
        }),
    );
}

function bullets(items: string[]): Paragraph[] {
  return items.map(
    (item) =>
      new Paragraph({
        bullet: { level: 0 },
        spacing: { after: 60 },
        children: [new TextRun({ text: item, size: 20 })],
      }),
  );
}

function citedBullets(
  items: Array<{ text: string; evidenceIds: string[] }>,
  citations: Record<string, ChatCitation>,
): Paragraph[] {
  return items.map((item) => {
    const known = item.evidenceIds.filter((id) => citations[id]);
    return new Paragraph({
      bullet: { level: 0 },
      spacing: { after: 60 },
      children: [
        new TextRun({ text: item.text, size: 20 }),
        ...(known.length
          ? [new TextRun({ text: ` [${known.join(", ")}]`, size: 16, color: ACCENT, bold: true })]
          : []),
      ],
    });
  });
}

function meta(label: string, value: string): Paragraph {
  return new Paragraph({
    spacing: { after: 40 },
    children: [
      new TextRun({ text: `${label}: `, bold: true, size: 18 }),
      new TextRun({ text: value, size: 18, color: MUTED }),
    ],
  });
}

function cell(text: string, options?: { bold?: boolean; shading?: string }): TableCell {
  return new TableCell({
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
    ...(options?.shading
      ? { shading: { type: ShadingType.CLEAR, fill: options.shading } }
      : {}),
    children: [
      new Paragraph({
        children: [new TextRun({ text, size: 17, bold: options?.bold })],
      }),
    ],
  });
}

function dataTable(headers: string[], rows: Array<Array<string | TableCell>>): Table[] {
  if (rows.length === 0) return [];
  return [
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 2, color: BORDER },
        bottom: { style: BorderStyle.SINGLE, size: 2, color: BORDER },
        left: { style: BorderStyle.NONE, size: 0, color: BORDER },
        right: { style: BorderStyle.NONE, size: 0, color: BORDER },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: BORDER },
        insideVertical: { style: BorderStyle.NONE, size: 0, color: BORDER },
      },
      rows: [
        new TableRow({
          tableHeader: true,
          children: headers.map((header) =>
            cell(header, { bold: true, shading: "F3F4F8" }),
          ),
        }),
        ...rows.map(
          (row) =>
            new TableRow({
              children: row.map((value) =>
                typeof value === "string" ? cell(value) : value,
              ),
            }),
        ),
      ],
    }),
    // Word collapses adjacent tables without a separating paragraph.
    new Paragraph({ spacing: { after: 160 }, children: [] }),
  ];
}

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

function formatDateTime(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
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
  if (!Number.isFinite(numeric)) return value.amount;
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

export async function renderReportDocx(input: {
  data: SerializedTenderReport;
  labels: ReportLabels;
  locale: string;
}): Promise<Buffer> {
  const { labels, locale } = input;
  const data = input.data;
  const report = data.report as TenderReportContent;
  const citations = data.citations ?? {};
  const percent = (value: number) =>
    `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;

  const children: Array<Paragraph | Table> = [
    new Paragraph({
      spacing: { after: 60 },
      children: [
        new TextRun({
          text: labels.documentTitle.toUpperCase(),
          bold: true,
          size: 16,
          color: ACCENT,
        }),
      ],
    }),
    new Paragraph({
      spacing: { after: 160 },
      children: [new TextRun({ text: data.tender.title ?? "—", bold: true, size: 40 })],
    }),
    meta(labels.buyer, data.tender.buyerName ?? "—"),
    meta(labels.deadline, formatDateTime(data.tender.submissionDeadline, locale)),
    meta(
      labels.estimatedValue,
      formatMoney(data.tender.estimatedValue, locale, labels.notProvided),
    ),
    meta(labels.procedure, data.tender.procedureType ?? "—"),
    ...(data.companyName ? [meta(labels.preparedFor, data.companyName)] : []),
    meta(
      labels.generatedAt,
      `${formatDateTime(data.generatedAt, locale)} · ${data.model.providerModel}`,
    ),
    ...(data.stale
      ? [
          new Paragraph({
            spacing: { before: 160, after: 60 },
            shading: { type: ShadingType.CLEAR, fill: "FFF8E6" },
            children: [new TextRun({ text: labels.staleWarning, size: 18, color: "7A5A10" })],
          }),
        ]
      : []),
  ];

  children.push(heading(labels.sections.executiveSummary), ...prose(report.executiveSummary));

  children.push(
    heading(labels.sections.recommendation),
    new Paragraph({
      spacing: { after: 120 },
      shading: {
        type: ShadingType.CLEAR,
        fill:
          report.recommendation.decision === "bid"
            ? "E9F9F3"
            : report.recommendation.decision === "conditional"
              ? "FFF4EC"
              : "FFF0ED",
      },
      children: [
        new TextRun({
          text: `${labels.recommendation.decision[report.recommendation.decision]} · ${percent(
            report.recommendation.confidence,
          )} ${labels.recommendation.confidence}`,
          bold: true,
          size: 22,
        }),
      ],
    }),
    ...prose(report.recommendation.rationale),
  );
  if (report.recommendation.conditions.length) {
    children.push(
      subHeading(labels.recommendation.conditions),
      ...bullets(report.recommendation.conditions),
    );
  }

  children.push(
    heading(labels.sections.scores),
    ...dataTable(
      ["", ""],
      [
        [labels.scores.eligibilityFit, percent(report.scores.eligibilityFit)],
        [labels.scores.technicalFit, percent(report.scores.technicalFit)],
        [labels.scores.capacityFit, percent(report.scores.capacityFit)],
        [
          labels.scores.commercialAttractiveness,
          percent(report.scores.commercialAttractiveness),
        ],
        [
          `${labels.scores.contractRisk} (${labels.scores.riskHint})`,
          percent(report.scores.contractRisk),
        ],
        [labels.scores.deadlineFeasibility, percent(report.scores.deadlineFeasibility)],
      ],
    ),
  );

  children.push(
    heading(labels.sections.overview),
    subHeading(labels.overview.purpose),
    ...prose(report.tenderOverview.purpose),
    subHeading(labels.overview.scope),
    ...prose(report.tenderOverview.scope),
  );
  if (report.tenderOverview.lots.length) {
    children.push(
      subHeading(labels.overview.lots),
      ...dataTable(
        [labels.overview.lots, labels.overview.scope, ""],
        report.tenderOverview.lots.map((lot) => [
          lot.name,
          lot.summary,
          lot.relevantToCompany ? labels.overview.relevant : labels.overview.notRelevant,
        ]),
      ),
    );
  }
  children.push(
    subHeading(labels.overview.buyer),
    ...prose(report.tenderOverview.buyer),
    subHeading(labels.overview.procedure),
    ...prose(report.tenderOverview.procedure),
  );

  children.push(
    heading(labels.sections.keyFacts),
    ...dataTable(
      ["", ""],
      report.keyFacts.map((fact) => [
        fact.label,
        fact.note ? `${fact.value} — ${fact.note}` : fact.value,
      ]),
    ),
  );

  children.push(
    heading(labels.sections.timeline),
    ...dataTable(
      [labels.timeline.date, labels.timeline.event, labels.timeline.detail],
      report.timeline.map((entry) => [
        entry.critical
          ? `${formatDate(entry.date, locale)} (${labels.timeline.critical})`
          : formatDate(entry.date, locale),
        entry.label,
        entry.detail,
      ]),
    ),
  );

  children.push(
    heading(labels.sections.requirements),
    ...dataTable(
      [
        labels.requirements.requirement,
        labels.requirements.category,
        labels.requirements.mandatory,
        labels.requirements.status,
        labels.requirements.evidence,
        labels.requirements.action,
      ],
      report.requirements.map((entry) => {
        const known = entry.evidenceIds.filter((id) => citations[id]);
        return [
          known.length ? `${entry.requirement} [${known.join(", ")}]` : entry.requirement,
          labels.requirements.categories[entry.category] ?? entry.category,
          entry.mandatory === null
            ? "—"
            : entry.mandatory
              ? labels.requirements.mandatoryYes
              : labels.requirements.mandatoryNo,
          cell(labels.requirements.statuses[entry.companyStatus] ?? entry.companyStatus, {
            bold: true,
            shading: STATUS_SHADING[entry.companyStatus],
          }),
          entry.evidence,
          entry.action ?? "—",
        ];
      }),
    ),
  );

  children.push(
    heading(labels.sections.commercials),
    subHeading(labels.commercials.valueAssessment),
    ...prose(report.commercials.valueAssessment),
    subHeading(labels.commercials.paymentTerms),
    ...prose(report.commercials.paymentTerms),
    subHeading(labels.commercials.retentionsAndSecurities),
    ...prose(report.commercials.retentionsAndSecurities),
    subHeading(labels.commercials.penalties),
    ...prose(report.commercials.penalties),
  );
  if (report.commercials.priceRisks.length) {
    children.push(
      subHeading(labels.commercials.priceRisks),
      ...bullets(report.commercials.priceRisks),
    );
  }

  children.push(heading(labels.sections.companyFit), ...prose(report.companyFit.summary));
  if (report.companyFit.strengths.length) {
    children.push(
      subHeading(labels.companyFit.strengths),
      ...citedBullets(report.companyFit.strengths, citations),
    );
  }
  if (report.companyFit.gaps.length) {
    children.push(
      subHeading(labels.companyFit.gaps),
      ...citedBullets(report.companyFit.gaps, citations),
    );
  }
  if (report.companyFit.differentiators.length) {
    children.push(
      subHeading(labels.companyFit.differentiators),
      ...bullets(report.companyFit.differentiators),
    );
  }
  children.push(
    subHeading(labels.companyFit.capacity),
    ...prose(report.companyFit.capacityAssessment),
  );

  children.push(
    heading(labels.sections.risks),
    ...dataTable(
      [
        labels.risks.risk,
        labels.risks.severity,
        labels.risks.likelihood,
        labels.risks.impact,
        labels.risks.mitigation,
      ],
      report.risks.map((risk) => [
        risk.title,
        cell(labels.risks.levels[risk.severity] ?? risk.severity, {
          bold: true,
          shading: STATUS_SHADING[risk.severity],
        }),
        labels.risks.levels[risk.likelihood] ?? risk.likelihood,
        risk.impact,
        risk.mitigation,
      ]),
    ),
  );

  children.push(heading(labels.sections.competition), ...prose(report.competition));

  children.push(heading(labels.sections.bidStrategy));
  if (report.bidStrategy.winThemes.length) {
    children.push(
      subHeading(labels.bidStrategy.winThemes),
      ...bullets(report.bidStrategy.winThemes),
    );
  }
  children.push(
    subHeading(labels.bidStrategy.pricingApproach),
    ...prose(report.bidStrategy.pricingApproach),
    subHeading(labels.bidStrategy.partnering),
    ...prose(report.bidStrategy.partnering),
    subHeading(labels.bidStrategy.effortEstimate),
    ...prose(report.bidStrategy.effortEstimate),
  );

  children.push(
    heading(labels.sections.actionPlan),
    ...dataTable(
      [
        labels.actionPlan.action,
        labels.actionPlan.priority,
        labels.actionPlan.dueBy,
        labels.actionPlan.rationale,
      ],
      report.actionPlan.map((entry) => [
        entry.action,
        labels.actionPlan.priorities[entry.priority] ?? entry.priority,
        formatDate(entry.dueBy, locale),
        entry.rationale,
      ]),
    ),
  );

  children.push(
    heading(labels.sections.openQuestions),
    ...dataTable(
      [labels.openQuestions.question, labels.openQuestions.whoToAsk, labels.openQuestions.why],
      report.openQuestions.map((entry) => [entry.question, entry.whoToAsk, entry.why]),
    ),
  );

  children.push(
    heading(labels.sections.documentChecklist),
    ...dataTable(
      [labels.checklist.document, labels.checklist.source, labels.checklist.note],
      report.documentChecklist.map((entry) => [
        entry.document,
        labels.checklist.sources[entry.source] ?? entry.source,
        entry.note ?? "—",
      ]),
    ),
  );

  if (report.dataGaps.length) {
    children.push(heading(labels.sections.dataGaps), ...bullets(report.dataGaps));
  }

  const citationEntries = Object.entries(citations);
  if (citationEntries.length) {
    children.push(
      heading(labels.sections.sources),
      ...citationEntries.map(
        ([id, citation]) =>
          new Paragraph({
            spacing: { after: 60 },
            children: [
              new TextRun({ text: `[${id}] `, bold: true, size: 16, color: ACCENT }),
              new TextRun({ text: `${citation.fileName} — `, size: 16, color: MUTED }),
              new TextRun({ text: `„${citation.quote}"`, size: 16, italics: true }),
            ],
          }),
      ),
    );
  }

  children.push(
    heading(labels.sections.coverage),
    new Paragraph({
      spacing: { after: 200 },
      children: [
        new TextRun({
          text: [
            `${labels.coverage.tenderExcerpts}: ${data.coverage.tenderChunkCount}`,
            `${labels.coverage.companyExcerpts}: ${data.coverage.companyChunkCount}`,
            `${labels.coverage.extractions}: ${Object.keys(data.coverage.extractionStatuses).length}`,
            `${labels.coverage.overviewUsed}: ${data.coverage.hasOverview ? labels.coverage.yes : labels.coverage.no}`,
            `${labels.coverage.fitUsed}: ${data.coverage.hasFit ? labels.coverage.yes : labels.coverage.no}`,
            `${labels.coverage.verdictUsed}: ${data.coverage.hasVerdict ? labels.coverage.yes : labels.coverage.no}`,
          ].join(" · "),
          size: 16,
          color: MUTED,
        }),
      ],
    }),
    new Paragraph({
      border: { top: { style: BorderStyle.SINGLE, size: 4, color: BORDER, space: 6 } },
      children: [
        new TextRun({
          text: `${labels.disclaimer} · ${labels.poweredBy}`,
          size: 14,
          color: MUTED,
        }),
      ],
    }),
  );

  const document = new Document({
    creator: labels.poweredBy,
    title: `${labels.documentTitle} — ${data.tender.title ?? ""}`,
    description: labels.disclaimer,
    styles: {
      default: {
        document: { run: { font: "Calibri", size: 20 } },
      },
    },
    sections: [
      {
        properties: {},
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    text: `${labels.page} `,
                    size: 14,
                    color: MUTED,
                  }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 14, color: MUTED }),
                  new TextRun({ text: " / ", size: 14, color: MUTED }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 14, color: MUTED }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(document);
}
