import { z } from "zod";

/**
 * The full tender report: one exhaustive, decision-ready document synthesized
 * from every artifact the system holds about a tender and about the company.
 *
 * The section set is FIXED rather than a free list of headings, because three
 * consumers render the same object — the report page, the PDF and the DOCX —
 * and each needs to know what it is laying out. Sections the material cannot
 * support come back empty rather than invented; the renderers skip them.
 */

export const REPORT_PROMPT_VERSION = "rep-p1";

const citedText = z.object({
  text: z.string().describe("The statement, as a complete sentence"),
  evidenceIds: z
    .array(z.string())
    .describe(
      "IDs from the evidence table that support this statement (E*/R*/C*). Empty only when nothing in the table covers it",
    ),
});

const keyFact = z.object({
  label: z.string().describe("Short field name, e.g. 'Submission deadline'"),
  value: z.string().describe("The value as it should be displayed"),
  note: z
    .string()
    .nullable()
    .describe("Short qualifier: caveat, source, or why it matters. Null if none"),
});

const timelineEntry = z.object({
  date: z
    .string()
    .nullable()
    .describe("ISO date (YYYY-MM-DD) when known, else null"),
  label: z.string().describe("What happens on this date"),
  detail: z.string().describe("One or two sentences of context"),
  critical: z
    .boolean()
    .describe("True for dates that end the opportunity if missed"),
});

const requirement = z.object({
  requirement: z.string().describe("The requirement, stated concretely"),
  category: z
    .enum([
      "eligibility",
      "technical",
      "financial",
      "insurance",
      "certification",
      "reference",
      "formal",
      "other",
    ])
    .describe("Which family of requirement this is"),
  mandatory: z
    .boolean()
    .nullable()
    .describe("True if mandatory, false if optional, null if the material does not say"),
  companyStatus: z
    .enum(["met", "partial", "gap", "unknown"])
    .describe(
      "Whether the COMPANY satisfies it, judged from the company profile and documents. 'unknown' when the company data is silent",
    ),
  evidence: z
    .string()
    .describe("Why that status — cite the company fact or note what is missing"),
  action: z
    .string()
    .nullable()
    .describe("What the company must do to satisfy it, or null when already met"),
  evidenceIds: z.array(z.string()),
});

const risk = z.object({
  title: z.string().describe("Short risk name"),
  severity: z.enum(["low", "medium", "high"]),
  likelihood: z.enum(["low", "medium", "high"]),
  impact: z.string().describe("What happens to the company if it materializes"),
  mitigation: z.string().describe("Concrete mitigation or control"),
  evidenceIds: z.array(z.string()),
});

const action = z.object({
  action: z.string().describe("An imperative, concrete next step"),
  priority: z.enum(["immediate", "high", "normal"]),
  dueBy: z
    .string()
    .nullable()
    .describe("ISO date (YYYY-MM-DD) derived from the tender's deadlines, or null"),
  rationale: z.string().describe("Why this step, in one sentence"),
});

const openQuestion = z.object({
  question: z.string().describe("A question to put to the contracting authority"),
  whoToAsk: z.string().describe("Where to direct it, e.g. the buyer's contact"),
  why: z.string().describe("What decision this question unblocks"),
});

export const reportSchema = z.object({
  executiveSummary: z
    .string()
    .describe(
      "3-5 paragraphs a managing director could read alone and decide from: what the tender is, whether to bid, the decisive reasons, and what must happen next. Paragraph breaks as \\n\\n",
    ),
  recommendation: z.object({
    decision: z.enum(["bid", "conditional", "no_bid"]),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe("How strongly the evidence supports the decision"),
    rationale: z
      .string()
      .describe("A full paragraph justifying the decision on the evidence"),
    conditions: z
      .array(z.string())
      .describe(
        "For a conditional decision, what must be true to proceed. Empty otherwise",
      ),
  }),
  scores: z
    .object({
      eligibilityFit: z.number().min(0).max(1),
      technicalFit: z.number().min(0).max(1),
      capacityFit: z.number().min(0).max(1),
      commercialAttractiveness: z.number().min(0).max(1),
      contractRisk: z
        .number()
        .min(0)
        .max(1)
        .describe("Higher means MORE risk"),
      deadlineFeasibility: z.number().min(0).max(1),
    })
    .describe("0..1 sub-scores behind the recommendation"),
  tenderOverview: z.object({
    purpose: z
      .string()
      .describe("What the buyer is procuring and why — a full paragraph"),
    scope: z
      .string()
      .describe(
        "Exhaustive description of the work: packages, quantities, methods, areas, interfaces. Multi-paragraph, \\n\\n separated",
      ),
    lots: z
      .array(
        z.object({
          name: z.string(),
          summary: z.string(),
          relevantToCompany: z.boolean(),
        }),
      )
      .describe("One entry per lot; empty when the tender is not divided"),
    buyer: z
      .string()
      .describe("Who the contracting authority is and what that implies for a bidder"),
    procedure: z
      .string()
      .describe("Procedure type, what it means in practice, and the award mechanics"),
  }),
  keyFacts: z
    .array(keyFact)
    .describe("10-20 facts a bidder must not miss: dates, values, thresholds, codes"),
  timeline: z.array(timelineEntry).describe("Every known date, in chronological order"),
  requirements: z
    .array(requirement)
    .describe(
      "Every participation and suitability requirement found, each assessed against THIS company",
    ),
  commercials: z.object({
    valueAssessment: z
      .string()
      .describe("Contract value, how it was derived, and what it means for this company"),
    paymentTerms: z.string().describe("Payment schedule, deadlines, invoicing rules"),
    retentionsAndSecurities: z
      .string()
      .describe("Retentions, warranty holdbacks, bonds and guarantees demanded"),
    penalties: z.string().describe("Contractual penalties, caps, and their triggers"),
    priceRisks: z
      .array(z.string())
      .describe("Specific pricing/escalation/quantity risks to build into the bid"),
  }),
  companyFit: z.object({
    summary: z.string().describe("A paragraph on how well this company matches"),
    strengths: z.array(citedText),
    gaps: z.array(citedText),
    differentiators: z
      .array(z.string())
      .describe("What this company can claim that competitors likely cannot"),
    capacityAssessment: z
      .string()
      .describe("Whether the company's size, revenue and bonding can carry this contract"),
  }),
  risks: z.array(risk).describe("6-12 risks, most material first"),
  competition: z
    .string()
    .describe(
      "What the material implies about the competitive field: procedure openness, likely bidder profile, incumbency signals. Say plainly when this is inference rather than fact",
    ),
  bidStrategy: z.object({
    winThemes: z.array(z.string()).describe("Themes the bid should lead with"),
    pricingApproach: z.string().describe("How to approach pricing given the evidence"),
    partnering: z
      .string()
      .describe("Whether subcontractors, consortium partners or suppliers are needed"),
    effortEstimate: z
      .string()
      .describe("Realistic assessment of the effort to produce a compliant bid"),
  }),
  actionPlan: z.array(action).describe("Ordered, concrete next steps"),
  openQuestions: z.array(openQuestion),
  documentChecklist: z
    .array(
      z.object({
        document: z.string().describe("A document the bid must contain"),
        source: z
          .enum(["company_has", "must_obtain", "must_produce", "unknown"])
          .describe("Where it comes from, judged against the company's own documents"),
        note: z.string().nullable(),
      }),
    )
    .describe("Everything that has to be in the submission envelope"),
  dataGaps: z
    .array(z.string())
    .describe(
      "What this report could NOT establish and why — missing documents, silent notice, absent company data. Honesty here is the point",
    ),
});

export type TenderReportContent = z.infer<typeof reportSchema>;

export const REPORT_JSON_SCHEMA = z.toJSONSchema(reportSchema, {
  target: "draft-7",
}) as Record<string, unknown>;

/** The report is stored in every UI language; the UI picks by locale. */
export const REPORT_LOCALES = ["en", "de"] as const;
export type ReportLocale = (typeof REPORT_LOCALES)[number];

const LANGUAGE_NAME: Record<ReportLocale, string> = {
  en: "English",
  de: "German",
};

/**
 * Translation of an already-written report into the other UI language.
 *
 * Deliberately a SECOND pass over the finished analysis rather than a second
 * analysis: two independent runs could reach two different verdicts, and a
 * German reader must never be told "bid" while the English reader is told
 * "do not bid". Only free text moves; every enum, number, date and evidence id
 * is carried across untouched.
 */
export function buildTranslationPrompt(input: {
  report: TenderReportContent;
  from: ReportLocale;
  to: ReportLocale;
}): string {
  return [
    `You are a specialist translator for German public-procurement documents. Translate the tender report below from ${LANGUAGE_NAME[input.from]} into ${LANGUAGE_NAME[input.to]}.`,
    "",
    "RULES",
    "1. Return the SAME JSON structure. Every key must be present.",
    "2. Translate ONLY human-readable prose. Never alter, reorder or drop anything else.",
    "3. These are carried over EXACTLY, byte for byte: all enum values (decision, category, companyStatus, severity, likelihood, priority, source), all numbers and scores, all ISO dates, all booleans, and every entry of every evidenceIds array.",
    "4. Keep proper nouns, organisation names, file names and legal references verbatim (for example \"§ 13 VOB/B\", \"VOB/A\", \"Form 124\").",
    input.to === "de"
      ? "5. Use the standard German procurement register a Bauleiter or Kalkulator would expect (Eignung, Nachweise, Zuschlagskriterien, Vertragsstrafe, Sicherheitseinbehalt). Address the reader formally."
      : "5. Use plain professional English. Where a German procurement term has no clean equivalent, keep the German word and add a short gloss in parentheses on first use.",
    "6. Preserve paragraph breaks (\\n\\n) exactly where they appear.",
    "7. Do not improve, shorten, extend or correct the analysis. Translation only.",
    "",
    "=== REPORT JSON ===",
    JSON.stringify(input.report),
  ].join("\n");
}
