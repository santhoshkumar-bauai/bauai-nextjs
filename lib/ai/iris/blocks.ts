import { z } from "zod";

/**
 * Iris's generative-UI component catalog.
 *
 * This is the whole point of the POC: instead of the agent describing a tender
 * in prose and leaving the reader with nothing to click, it PICKS a component
 * from a fixed, typed catalog and the server fills it with real data.
 *
 * Three rules make that safe, and they are the same posture as
 * `lib/ai/agent/ui-calls.ts`:
 *
 *   1. The model chooses a BLOCK KIND and ARGUMENTS (ids, queries, filters).
 *      It never authors markup, class names, colours or layout.
 *   2. The server builds the payload from the real collections and validates
 *      it against the schema below before it reaches the wire. A block that
 *      fails validation is dropped, not rendered half-formed.
 *   3. The client re-narrows on the schema-derived TYPE, so adding a field
 *      here is a compile error in the component that forgot it.
 *
 * Only two blocks carry model-authored prose (`choice-prompt`, `filter-refine`),
 * because asking the user a question is intrinsically generative. Everything
 * else is data the system already owns.
 *
 * Client-safe: this module imports nothing but zod, so components may import
 * the inferred types directly.
 */

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

/** Semantic colour intent. Components map it; the model never names a colour. */
export const ToneSchema = z.enum(["neutral", "primary", "positive", "warning", "critical"]);
export type Tone = z.infer<typeof ToneSchema>;

export const SeveritySchema = z.enum(["low", "medium", "high"]);
export const DecisionSchema = z.enum(["bid", "conditional", "no_bid"]);
export type Decision = z.infer<typeof DecisionSchema>;

const MoneySchema = z.object({
  amount: z.string().nullable(),
  currency: z.string().nullable(),
});

const EvidenceSchema = z.object({
  quote: z.string(),
  fileName: z.string(),
  page: z.number().nullable().optional(),
  sectionPath: z.array(z.string()).optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/**
 * The tender shape every list-ish block reuses. Deadline arithmetic is
 * pre-computed server-side (`daysLeft`) — the model gets dates wrong and the
 * client should not have to guess the reference timezone either.
 */
export const TenderCardSchema = z.object({
  tenderId: z.string(),
  title: z.string().nullable(),
  buyer: z.string().nullable(),
  city: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  submissionDeadline: z.string().nullable().optional(),
  daysLeft: z.number().nullable().optional(),
  /** 0..1 blended relevance. Absent outside the matched feed. */
  matchScore: z.number().nullable().optional(),
  scoreBreakdown: z
    .object({ cpv: z.number(), location: z.number(), timing: z.number() })
    .nullable()
    .optional(),
  estimatedValue: MoneySchema.nullable().optional(),
  cpvCodes: z.array(z.string()).optional(),
  regions: z.array(z.string()).optional(),
  /** Kanban column this tender sits in for the company, if any. */
  workspaceStatus: z.string().nullable().optional(),
  decision: DecisionSchema.nullable().optional(),
  hasReport: z.boolean().optional(),
});
export type TenderCard = z.infer<typeof TenderCardSchema>;

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export const MetricSummarySchema = z.object({
  title: z.string(),
  caption: z.string().nullable().optional(),
  metrics: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
        unit: z.string().nullable().optional(),
        hint: z.string().nullable().optional(),
        tone: ToneSchema.optional(),
        /** 0..1 — draws a fill bar under the tile when present. */
        progress: z.number().min(0).max(1).nullable().optional(),
      }),
    )
    .min(1)
    .max(6),
});

export const TenderGridSchema = z.object({
  title: z.string(),
  caption: z.string().nullable().optional(),
  /** Matches in the full result set, which may exceed `items`. */
  total: z.number().nullable().optional(),
  items: z.array(TenderCardSchema).max(15),
  emptyHint: z.string().nullable().optional(),
});

export const TenderSpotlightSchema = z.object({
  tender: TenderCardSchema,
  description: z.string().nullable().optional(),
  procedureType: z.string().nullable().optional(),
  contractNature: z.string().nullable().optional(),
  categories: z.array(z.string()).optional(),
  lots: z
    .array(
      z.object({
        title: z.string().nullable(),
        deadline: z.string().nullable(),
        value: MoneySchema.nullable(),
      }),
    )
    .max(8)
    .optional(),
  /** What the pipeline already produced for this tender. Drives the "what
   * can I ask next" affordances, so an empty analysis is visible, not silent. */
  coverage: z
    .object({
      fetchedFiles: z.number(),
      readableFiles: z.number(),
      indexedChunks: z.number(),
      hasOverview: z.boolean(),
      hasReport: z.boolean(),
      hasVerdict: z.boolean(),
      extractionCount: z.number(),
    })
    .nullable()
    .optional(),
  highlights: z.array(z.string()).max(8).optional(),
  sourceUrl: z.string().nullable().optional(),
});

export const TenderCompareSchema = z.object({
  title: z.string(),
  caption: z.string().nullable().optional(),
  columns: z
    .array(
      z.object({
        tenderId: z.string(),
        title: z.string().nullable(),
        buyer: z.string().nullable(),
        decision: DecisionSchema.nullable().optional(),
      }),
    )
    .min(2)
    .max(5),
  /** `cells` is positional against `columns` — same length, same order. */
  rows: z
    .array(
      z.object({
        label: z.string(),
        cells: z.array(
          z.object({
            text: z.string(),
            tone: ToneSchema.optional(),
          }),
        ),
      }),
    )
    .max(14),
});

export const BidVerdictSchema = z.object({
  tenderId: z.string().nullable().optional(),
  tenderTitle: z.string().nullable().optional(),
  recommendation: DecisionSchema,
  rationale: z.string(),
  /** 0..100 per axis, already normalized from the stored 0..1 breakdown. */
  scores: z
    .array(z.object({ label: z.string(), value: z.number().min(0).max(100) }))
    .max(8),
  risks: z
    .array(z.object({ text: z.string(), severity: SeveritySchema, uncited: z.boolean().optional() }))
    .max(10),
  blockers: z.array(z.string()).max(10),
  openQuestions: z.array(z.string()).max(8),
  generatedAt: z.string().nullable().optional(),
  stale: z.boolean().optional(),
});

export const RequirementChecklistSchema = z.object({
  title: z.string(),
  caption: z.string().nullable().optional(),
  items: z
    .array(
      z.object({
        label: z.string(),
        /** `unknown` is a first-class outcome — a missing extraction must not
         * render as a passed check. */
        status: z.enum(["met", "partial", "gap", "unknown"]),
        detail: z.string().nullable().optional(),
        mandatory: z.boolean().optional(),
        evidence: EvidenceSchema.nullable().optional(),
      }),
    )
    .max(24),
});

export const DeadlineTimelineSchema = z.object({
  title: z.string(),
  caption: z.string().nullable().optional(),
  items: z
    .array(
      z.object({
        label: z.string(),
        date: z.string().nullable(),
        kind: z.enum([
          "publication",
          "questions",
          "site_visit",
          "submission",
          "binding",
          "award",
          "milestone",
        ]),
        detail: z.string().nullable().optional(),
        daysLeft: z.number().nullable().optional(),
      }),
    )
    .max(12),
});

export const DocumentShelfSchema = z.object({
  title: z.string(),
  scope: z.enum(["tender", "company"]),
  caption: z.string().nullable().optional(),
  items: z
    .array(
      z.object({
        fileName: z.string(),
        docClass: z.string().nullable().optional(),
        mimeType: z.string().nullable().optional(),
        sizeBytes: z.number().nullable().optional(),
        /** Searchable through the retrieval tools. */
        indexed: z.boolean().optional(),
        /** Text extraction succeeded, so the agent can read it end to end. */
        readable: z.boolean().optional(),
        updatedAt: z.string().nullable().optional(),
      }),
    )
    .max(40),
});

export const EvidencePanelSchema = z.object({
  title: z.string(),
  query: z.string().nullable().optional(),
  scope: z.enum(["tender", "company"]),
  items: z.array(EvidenceSchema.extend({ docClass: z.string().nullable().optional() })).max(12),
});

export const PipelineBoardSchema = z.object({
  title: z.string(),
  caption: z.string().nullable().optional(),
  columns: z
    .array(
      z.object({
        status: z.string(),
        count: z.number(),
        items: z
          .array(
            z.object({
              tenderId: z.string(),
              title: z.string().nullable(),
              buyer: z.string().nullable(),
              daysLeft: z.number().nullable().optional(),
            }),
          )
          .max(8),
      }),
    )
    .max(5),
});

export const CpvExplorerSchema = z.object({
  title: z.string(),
  caption: z.string().nullable().optional(),
  items: z
    .array(
      z.object({
        code: z.string(),
        name: z.string(),
        division: z.string().nullable().optional(),
        /** True when the code is already on the company profile. */
        onProfile: z.boolean().optional(),
      }),
    )
    .max(25),
});

export const CompanySnapshotSchema = z.object({
  name: z.string(),
  city: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  employees: z.number().nullable().optional(),
  foundedYear: z.number().nullable().optional(),
  capabilities: z.array(z.string()).max(16),
  cpvCodes: z.array(z.object({ code: z.string(), name: z.string() })).max(16),
  regions: z.array(z.string()).max(12),
  documentCount: z.number().nullable().optional(),
  indexedDocumentCount: z.number().nullable().optional(),
});

/**
 * Interactive: the agent asks, the user clicks, the click sends `prompt` back
 * as the next user turn. This is the round trip that makes generative UI an
 * INPUT surface and not just a nicer output format.
 */
export const ChoicePromptSchema = z.object({
  question: z.string(),
  caption: z.string().nullable().optional(),
  options: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        description: z.string().nullable().optional(),
        /** The message sent on click. Authored by the model, shown verbatim
         * as the user's own turn so the transcript stays honest. */
        prompt: z.string(),
      }),
    )
    .min(2)
    .max(5),
  allowFreeText: z.boolean().optional(),
});

/** Interactive: facet controls that re-run the feed with the user's picks. */
export const FilterRefineSchema = z.object({
  title: z.string(),
  caption: z.string().nullable().optional(),
  facets: z
    .array(
      z.object({
        key: z.string(),
        label: z.string(),
        multi: z.boolean().optional(),
        values: z
          .array(
            z.object({
              value: z.string(),
              label: z.string(),
              selected: z.boolean().optional(),
              count: z.number().nullable().optional(),
            }),
          )
          .max(20),
      }),
    )
    .max(5),
  deadlineDays: z.number().nullable().optional(),
  submitLabel: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Kind → schema. Adding an entry here and a component in
 * `components/gen-ui/blocks` is the whole cost of a new generative-UI block:
 * the wire type, the tool validation and the client union all derive from it.
 */
export const BLOCK_SCHEMAS = {
  "metric-summary": MetricSummarySchema,
  "tender-grid": TenderGridSchema,
  "tender-spotlight": TenderSpotlightSchema,
  "tender-compare": TenderCompareSchema,
  "bid-verdict": BidVerdictSchema,
  "requirement-checklist": RequirementChecklistSchema,
  "deadline-timeline": DeadlineTimelineSchema,
  "document-shelf": DocumentShelfSchema,
  "evidence-panel": EvidencePanelSchema,
  "pipeline-board": PipelineBoardSchema,
  "cpv-explorer": CpvExplorerSchema,
  "company-snapshot": CompanySnapshotSchema,
  "choice-prompt": ChoicePromptSchema,
  "filter-refine": FilterRefineSchema,
} as const;

export type BlockKind = keyof typeof BLOCK_SCHEMAS;

export const BLOCK_KINDS = Object.keys(BLOCK_SCHEMAS) as BlockKind[];

/** The validated payload for one kind. */
export type BlockPayload<K extends BlockKind> = z.infer<(typeof BLOCK_SCHEMAS)[K]>;

/**
 * Blocks that fill the right-hand canvas rather than sitting inline.
 *
 * The split is by reading posture, not by size: a spotlight, a verdict and a
 * comparison are things you keep open while asking follow-ups, so pinning them
 * beats scrolling back up. Everything else reads once, in place.
 */
export const CANVAS_BLOCKS: readonly BlockKind[] = [
  "tender-spotlight",
  "tender-compare",
  "bid-verdict",
  "requirement-checklist",
];

/**
 * Per-block streaming envelope.
 *
 * A block is written TWICE under one id: `loading` the moment the tool starts,
 * `ready` when the data lands. The AI SDK reconciles on the id, so the
 * skeleton becomes the component in place instead of the layout jumping when
 * a slow aggregation finally returns.
 */
export type BlockState<K extends BlockKind> =
  | { status: "loading"; kind: K; title?: string }
  | { status: "ready"; kind: K; block: BlockPayload<K> }
  | { status: "error"; kind: K; message: string };

/** A ready block of any kind, as a discriminated union on `kind`. */
export type AnyReadyBlock = {
  [K in BlockKind]: { kind: K; block: BlockPayload<K> };
}[BlockKind];
