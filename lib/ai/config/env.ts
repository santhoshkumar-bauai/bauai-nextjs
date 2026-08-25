import { z } from "zod";

/**
 * AI subsystem configuration. Unlike `lib/ingestion/config/env.ts` (which is
 * eager and throws at import), this module validates lazily on first access so
 * that importing AI code from the Next.js app never crashes a build or a route
 * that does not touch the AI stack. Secrets (GEMINI_API_KEY) are asserted only
 * by the code paths that call the provider.
 */

const ModelRoleRef = z
  .string()
  .regex(/^[a-z0-9-]+:[A-Za-z0-9._-]+$/, 'expected "provider:model"');

/** `z.coerce.boolean()` maps "false" → true; env flags need real parsing. */
const boolFromEnv = (fallback: "true" | "false" = "false") =>
  z
    .enum(["true", "false", "1", "0"])
    .default(fallback)
    .transform((v) => v === "true" || v === "1");

const BoolFromEnv = boolFromEnv();

/**
 * Product-level reasoning effort. Six rungs so the strongest models can be
 * asked for their best, mapped onto each provider's own knob in
 * `lib/ai/agent/model.ts` — which CLAMPS, because no provider accepts all six:
 * Gemini's thinkingLevel stops at HIGH, and gpt-5.6 rejects both `minimal`
 * (a gpt-5.0 spelling) and `max` (probe P5).
 */
export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
const ReasoningEffortEnum = z.enum(REASONING_EFFORTS);

const AiEnvSchema = z.object({
  /** Embedding model identity — stamped onto every stored vector (§17.1). */
  embeddingModel: z.string().default("gemini-embedding-001"),
  embeddingVersion: z.string().default("2026-08"),
  /** MRL truncation target; vectors are L2-normalized after truncation. */
  embeddingDimensions: z.coerce.number().int().positive().default(1536),
  /** Gemini batchEmbedContents caps at 100 texts per call. */
  embeddingBatchSize: z.coerce.number().int().min(1).max(100).default(64),
  /** Requests per minute across all embedding calls (BullMQ limiter). */
  embeddingRpm: z.coerce.number().int().positive().default(100),

  /**
   * Role → "provider:model" map. Roles are the only thing call sites know;
   * providers/models swap here without touching callers.
   */
  modelRoles: z.record(z.string(), ModelRoleRef),

  /**
   * Per-role reasoning effort and output budget, spread over the built-in
   * defaults exactly like `modelRoles`. Two JSON knobs rather than ~20 flat
   * vars, because the interesting operation is "raise the report, lower the
   * match judge" and that should be one edit.
   *
   * `AI_AGENT_REASONING` / `AI_REPORT_REASONING` still win for their two roles
   * so already-deployed setups keep their behaviour.
   */
  roleReasoning: z.record(z.string(), ReasoningEffortEnum),
  roleMaxOutputTokens: z.record(z.string(), z.coerce.number().int().positive()),

  /**
   * Azure model-id → deployment-name. Roles name the MODEL
   * ("azure:gpt-5.6-luna") because that is the identity worth stamping on a
   * cached artifact; the deployment is infrastructure and lives here. Falls
   * back to `AZURE_OPENAI_DEPLOYMENT`, so the single-deployment case needs no
   * entry at all.
   */
  azureDeployments: z.record(z.string(), z.string()).default({}),
  /**
   * Responses API vs Chat Completions.
   *
   * Defaults ON, and that is not a preference. On this deployment
   * `/v1/chat/completions` rejects function tools combined with any
   * `reasoning_effort` above `none`:
   *
   *   "Function tools with reasoning_effort are not supported for luna-dev in
   *    /v1/chat/completions. To use function tools, use /v1/responses or set
   *    reasoning_effort to 'none'."
   *
   * Every agent here is a tool loop and per-role effort is the point of the
   * migration, so Responses is the only surface that satisfies both. The flag
   * exists as an escape hatch — turning it off means giving up reasoning on
   * every tool-calling role.
   */
  azureUseResponsesApi: boolFromEnv("true"),

  /** Hash-tagged so all BullMQ keys land on one Redis Cluster slot. */
  redisPrefix: z.string().default("{bauai:ai}"),
  workerConcurrency: z.coerce.number().int().positive().default(4),

  useRankFusion: BoolFromEnv,
  reranker: z.enum(["noop", "llm"]).default("noop"),

  chunkerVersion: z.string().default("v1"),
  chunkTargetTokens: z.coerce.number().int().positive().default(500),
  chunkMaxTokens: z.coerce.number().int().positive().default(1200),

  classifierVersion: z.string().default("v1"),

  /**
   * Tool-loop iterations per chat turn before the forced-finalize path. Raised
   * with the expanded registry: a coverage check followed by a report section
   * and a document search is now a normal, correct three-call turn, and the old
   * cap of 6 forced a finalize mid-investigation on top of that.
   */
  agentMaxIterations: z.coerce.number().int().positive().default(8),
  /** Global (non-tender) chats need longer find→drill-in tool chains. */
  agentGlobalMaxIterations: z.coerce.number().int().positive().default(10),
  /**
   * Generous because thinking models spend reasoning tokens from the SAME
   * budget — 2048 starved gemini-3.5-flash into empty answers on complex
   * multi-tool turns.
   */
  /** @deprecated Superseded by `roleMaxOutputTokens`, which reads the same
   * env var as the `agent` role default. Kept so nothing breaks mid-rollout. */
  agentMaxOutputTokens: z.coerce.number().int().positive().default(8192),
  /**
   * Hard ceiling on conversation messages, and the whole window strategy when
   * `agentHistoryMaxTokens` is unset (UI history is unlimited either way).
   */
  agentHistoryMaxMessages: z.coerce.number().int().positive().default(30),
  /**
   * Token budget for the model-visible window. Supersedes the message count
   * when set: 30 messages is under two turns of a tool-heavy chat, which was
   * the right cap when the window had to stay small and is badly wrong against
   * a million-token context.
   *
   * Left unset by default so the Gemini deployments behave exactly as before;
   * the Azure roles set it.
   */
  agentHistoryMaxTokens: z.coerce.number().int().positive().optional(),
  /**
   * Reasoning effort for thinking-capable agent models, mapped per provider
   * (Gemini thinkingConfig, OpenAI/Azure reasoning.effort, Anthropic thinking
   * budget). Unset = the role default from `defaultRoleReasoning()`.
   */
  agentReasoningEffort: ReasoningEffortEnum.optional(),

  /**
   * The full tender report is a single very long synthesis over every artifact
   * the system holds, so it gets its own budget rather than the agent's: a
   * large output allowance and, by default, maximum reasoning effort.
   */
  reportMaxOutputTokens: z.coerce.number().int().positive().default(32_768),
  reportReasoningEffort: ReasoningEffortEnum.default("high"),
  /** Tender document excerpts fed to the report prompt. */
  reportMaxTenderChunks: z.coerce.number().int().positive().default(40),
  /** Company document excerpts fed to the report prompt. */
  reportMaxCompanyChunks: z.coerce.number().int().positive().default(16),

  /**
   * AI tender matching. The company is embedded as several facet vectors,
   * each retrieves against the notice vector index, the lists are fused with
   * the deterministic CPV/geo/time ranking, and the head of the result is
   * judged by an LLM. Everything here bounds cost or recall.
   */
  matchEnabled: boolFromEnv("true"),
  /** Rows served per company — also the judging depth. */
  matchRankCap: z.coerce.number().int().positive().default(200),
  /** Distinct tenders kept after fusion, before scoring. */
  matchPoolCap: z.coerce.number().int().positive().default(400),
  /** $vectorSearch `limit` per facet. */
  matchCandidatesPerFacet: z.coerce.number().int().positive().default(250),
  /** $vectorSearch `numCandidates`; generous because deadline/isVisible are
   * post-filters and would otherwise starve the pool. */
  matchNumCandidates: z.coerce.number().int().positive().default(4000),
  matchMaxFacets: z.coerce.number().int().positive().default(24),
  matchJudgeBatch: z.coerce.number().int().positive().default(10),
  matchJudgeConcurrency: z.coerce.number().int().positive().default(3),
  /** A finished run older than this is refreshed by the sweep. */
  matchStaleHours: z.coerce.number().int().positive().default(6),
  /** Phase-4 BM25 arm over tender_search_documents.text. */
  matchLexical: BoolFromEnv,
  /**
   * Fusion arm weights, exposed as env so a ranking regression can be rolled
   * back without a deploy: `AI_MATCH_W_TEXT_ARM=0 AI_MATCH_W_RULE_ARM=1.2`
   * restores the pre-text-arm ordering exactly.
   */
  matchRuleArmWeight: z.coerce.number().min(0).default(0.6),
  matchTextArmWeight: z.coerce.number().min(0).default(0.9),
  matchPipelineVersion: z.string().default("v2"),
  matchProfileVersion: z.string().default("v1"),

  /** Context cap for the retrieval-targeted extraction path. */
  extractionMaxChunks: z.coerce.number().int().positive().default(16),
  /** Context cap for the full-document extraction path. */
  extractionMaxDocChars: z.coerce.number().int().positive().default(150_000),
  extractionRpm: z.coerce.number().int().positive().default(30),
  extractionConcurrency: z.coerce.number().int().positive().default(2),

  /**
   * GAEB bill-of-quantities support. The parser version is cache identity for
   * `gaeb_documents` (ledger convention: bumping it re-parses on next open).
   */
  gaebParserVersion: z.string().default("v1"),
  /** Positions per classify/price LLM call. */
  gaebFillBatchSize: z.coerce.number().int().min(1).max(50).default(20),
  gaebFillBatchConcurrency: z.coerce.number().int().min(1).max(4).default(2),
  /** Hard guard: runs above this many positions are rejected up front. */
  gaebFillMaxPositions: z.coerce.number().int().positive().default(3000),
  /** Above this many positions the run must go through the queue worker. */
  gaebFillInlineMaxItems: z.coerce.number().int().positive().default(60),
  gaebFillMaxOutputTokens: z.coerce.number().int().positive().default(16_384),
  /** Web price evidence for named products (search-grounded lookups). */
  gaebWebPricingEnabled: boolFromEnv("true"),
  gaebWebPricingMaxLookups: z.coerce.number().int().min(0).max(200).default(40),
});

export type AiEnv = z.infer<typeof AiEnvSchema>;

/** Shared parser for the role-keyed JSON knobs, so they fail the same way. */
function parseJsonRecord<T>(raw: string | undefined, name: string): Record<string, T> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, T>;
  } catch {
    throw new Error(`${name} must be a JSON object keyed by role, received: ${raw}`);
  }
}

function parseModelRoles(raw: string | undefined) {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new Error(
      `AI_MODEL_ROLES must be JSON like {"embedding":"gemini:gemini-embedding-001"}, received: ${raw}`,
    );
  }
}

/**
 * Role defaults.
 *
 * Every generation role runs on Azure `gpt-5.6-luna`. Per-role differentiation
 * moved from the MODEL to the reasoning effort and output budget below — one
 * deployment, thirteen distinct operating points — which is why the fill roles
 * no longer need separate pins to stay isolated from chat-model changes.
 *
 * `embedding` deliberately stays on Gemini. It is not a chat role, luna-dev is
 * a chat deployment, and moving it means re-embedding every stored vector and
 * rebuilding both Atlas vector indexes. `AzureOpenAIProvider.embed()` throws
 * with that explanation so a one-line role edit cannot start a silent corpus
 * rebuild.
 *
 * The `AI_*_MODEL` shortcuts still win where they are set, so a deployment
 * that has pinned a role keeps it, and `AI_MODEL_ROLES` overrides everything.
 */
function defaultModelRoles(): Record<string, string> {
  const luna = `azure:${process.env.AZURE_OPENAI_MODEL || "gpt-5.6-luna"}`;
  // Gemini remains reachable: setting any AI_*_MODEL shortcut to "gemini:…"
  // moves that one role back with no code change, which is the rollback path.
  const generation = process.env.GEMINI_MODEL ? `gemini:${process.env.GEMINI_MODEL}` : luna;
  const agent = luna;
  return {
    // NOT luna — see the note above.
    embedding: `gemini:${process.env.EMBEDDING_MODEL || "gemini-embedding-001"}`,
    extraction: generation,
    reasoning: generation,
    agent,
    /**
     * The report deserves the best model available. Point it at one explicitly
     * via AI_MODEL_ROLES.report (or the AI_REPORT_MODEL shortcut) — it falls
     * back to the agent model only so an unconfigured deployment still works.
     */
    report: process.env.AI_REPORT_MODEL || agent,
    /**
     * AI matching judges 200 tenders against the whole company profile — the
     * product's discovery surface, so it gets its own top-tier role rather
     * than sharing `reasoning` with the pipeline. Falls back through the
     * report model so an unconfigured deployment still works.
     */
    match: process.env.AI_MATCH_MODEL || process.env.AI_REPORT_MODEL || agent,
    /**
     * Dora reads the open workspace document and guides the user through it —
     * a flagship surface, so it gets its own role. Falls back through the
     * report model so an unconfigured deployment still works.
     */
    dora: process.env.AI_DORA_MODEL || process.env.AI_REPORT_MODEL || agent,
    /**
     * Streaming single-point edits (rewrite selection, continue writing) need
     * first-token latency more than planning depth — a smaller model streamed
     * word-by-word into the document. Falls back through the main dora role so
     * an unconfigured deployment still works.
     */
    dora_fast:
      process.env.AI_DORA_FAST_MODEL ||
      process.env.AI_DORA_MODEL ||
      process.env.AI_REPORT_MODEL ||
      agent,
    // The fill roles were pinned to their own model so chat-model changes
    // could not silently alter generated legal documents or priced offers.
    // With one deployment behind every role that isolation now comes from the
    // per-role effort and budget below — but the shortcuts still work, so any
    // of them can be pinned again the moment there is a second deployment.
    dora_fill: process.env.AI_DORA_FILL_MODEL || luna,
    // PDF discovery reads the file natively (layout, tables, scanned pages),
    // so it needs a PDF-capable model. Falls back to the Word fill model.
    dora_pdf_fill:
      process.env.AI_DORA_PDF_FILL_MODEL || process.env.AI_DORA_FILL_MODEL || luna,
    // GAEB position classification + price suggestion batches. Pinned like the
    // other fill roles so chat model changes cannot alter priced offers.
    dora_gaeb_fill:
      process.env.AI_DORA_GAEB_FILL_MODEL || process.env.AI_DORA_FILL_MODEL || luna,
    // Search-grounded product price lookups. Needs a provider with a native
    // web-search tool — Gemini googleSearch or the OpenAI/Azure web_search
    // server tool. Web pricing degrades to "no evidence" on a provider that
    // cannot search (see agent/web-search.ts).
    dora_gaeb_web:
      process.env.AI_DORA_GAEB_WEB_MODEL || process.env.AI_DORA_GAEB_FILL_MODEL || luna,
    /**
     * Otto guides a brand-new user through the product. It is the first thing
     * anyone experiences, and its planning step has to reason about a whole
     * registry at once — so it gets its own role rather than sharing `agent`.
     * Falls back through the report model so an unconfigured deployment works.
     */
    otto: process.env.AI_OTTO_MODEL || process.env.AI_REPORT_MODEL || agent,
    // Chat-based PDF form-filling agent (POC). Orchestrates tools, writes
    // sandbox Python and reads rendered pages plus 400dpi crops, so it needs
    // vision and the strongest reasoning in the product — which it gets from
    // its effort setting rather than a separate model.
    fill_agent: process.env.AI_FILL_AGENT_MODEL || luna,
  };
}

/**
 * Reasoning effort per role.
 *
 * Chosen from what each role actually does, not from a global "more is better":
 * reasoning tokens are billed from the SAME budget as the answer and they cost
 * latency, so effort is spent where a wrong answer is expensive and withheld
 * where waiting is the damage.
 *
 * `xhigh` is the top rung this model family accepts — `max` is rejected
 * (probe P5), and `minimal` is the gpt-5.0 spelling of `none`.
 */
function defaultRoleReasoning(): Record<string, string> {
  return {
    // Pipelines. Schema-shaped extraction, but German legal text distinguishes
    // Bindefrist from Zuschlagsfrist and cpv-derive is asked to REFUSE when the
    // evidence is vague — `none` starts guessing.
    extraction: "low",
    // Overview and fit: bilingual synthesis behind a user-facing page, cached
    // per corpus hash so it runs rarely. Worth real thought.
    reasoning: "medium",
    // Clara. Her visible failure mode is tool ordering, which is exactly what
    // reasoning buys. Drop to "low" if time-to-first-token regresses.
    agent: process.env.AI_AGENT_REASONING || "medium",
    // The most demanding synthesis in the product, and a background job — no
    // one is watching a stream. Not the top rung: latency is unbounded there
    // and N translations follow this call.
    report: process.env.AI_REPORT_REASONING || "xhigh",
    // Matching is the discovery surface and its quality is a known gap, so
    // effort is the right lever — but this is the top cost-watch item in the
    // system: batch 10 over a rank cap of 200 is ~20 calls per company per
    // refresh, swept every few hours for every tenant. First knob to lower.
    match: "medium",
    // Dora reads the open document and drives 13 tools over it.
    dora: "medium",
    // Streamed word-by-word into the document: first-token latency IS the
    // product here, so no thinking at all.
    dora_fast: "none",
    // Maps company facts onto up to 500 Word fields with exact node ids. A
    // wrong value lands in a legal document — but a user is waiting.
    dora_fill: "medium",
    // Strictly harder than dora_fill: vision over a scan plus anchor-text
    // geometry. Vision and layout is where effort pays most.
    dora_pdf_fill: "high",
    // Position classification and unit-price estimation with money at stake,
    // batched 20 at a time.
    dora_gaeb_fill: "medium",
    // Grounded research; the search results, not the thinking, carry the work.
    dora_gaeb_web: "low",
    // The first thing a new user experiences. The script is already in the
    // prompt and sanitizePlan() enforces correctness in code, so latency is
    // the thing worth optimising.
    otto: "low",
    // Orchestrates a Python sandbox, vision and multi-tool repair — the
    // hardest reasoning surface in the product, behind a feature flag.
    fill_agent: "high",
  };
}

/**
 * Output budget per role. Every value is larger than its pre-Azure equivalent
 * for one reason: on a reasoning model the thinking is billed from this same
 * budget, so the old numbers now buy noticeably less answer. The precedent is
 * `agentMaxOutputTokens` above — 2048 once starved gemini-3.5-flash into empty
 * replies for exactly this reason.
 *
 * Probe P14: exhausting the budget returns HTTP 200 with
 * finish_reason="length" and EMPTY content, so under-budgeting reads as "the
 * model said nothing", not as an error.
 */
function defaultRoleMaxOutputTokens(): Record<string, number> {
  const agent = process.env.AI_AGENT_MAX_OUTPUT_TOKENS || 16_384;
  return {
    extraction: 8_192,
    reasoning: 16_384,
    agent,
    report: process.env.AI_REPORT_MAX_OUTPUT_TOKENS || 65_536,
    match: 12_288,
    dora: 16_384,
    dora_fast: 6_000,
    dora_fill: 24_576,
    dora_pdf_fill: 32_768,
    dora_gaeb_fill: 24_576,
    dora_gaeb_web: 8_192,
    otto: 12_288,
    fill_agent: 16_384,
  } as Record<string, number>;
}

let cached: AiEnv | null = null;

export function aiEnv(): AiEnv {
  if (cached) return cached;
  cached = AiEnvSchema.parse({
    embeddingModel: process.env.EMBEDDING_MODEL,
    embeddingVersion: process.env.EMBEDDING_VERSION,
    embeddingDimensions: process.env.EMBEDDING_DIMENSIONS,
    embeddingBatchSize: process.env.EMBEDDING_BATCH_SIZE,
    embeddingRpm: process.env.EMBEDDING_RPM,
    modelRoles: {
      ...defaultModelRoles(),
      ...parseModelRoles(process.env.AI_MODEL_ROLES),
    },
    roleReasoning: {
      ...defaultRoleReasoning(),
      ...parseJsonRecord(process.env.AI_ROLE_REASONING, "AI_ROLE_REASONING"),
    },
    roleMaxOutputTokens: {
      ...defaultRoleMaxOutputTokens(),
      ...parseJsonRecord(process.env.AI_ROLE_MAX_OUTPUT_TOKENS, "AI_ROLE_MAX_OUTPUT_TOKENS"),
    },
    azureDeployments: parseJsonRecord(process.env.AI_AZURE_DEPLOYMENTS, "AI_AZURE_DEPLOYMENTS"),
    azureUseResponsesApi: process.env.AI_AZURE_RESPONSES,
    redisPrefix: process.env.AI_REDIS_PREFIX,
    workerConcurrency: process.env.AI_WORKER_CONCURRENCY,
    useRankFusion: process.env.AI_USE_RANK_FUSION,
    reranker: process.env.AI_RERANKER,
    chunkerVersion: process.env.CHUNKER_VERSION,
    chunkTargetTokens: process.env.CHUNK_TARGET_TOKENS,
    chunkMaxTokens: process.env.CHUNK_MAX_TOKENS,
    classifierVersion: process.env.CLASSIFIER_VERSION,
    agentMaxIterations: process.env.AI_AGENT_MAX_ITERATIONS,
    agentGlobalMaxIterations: process.env.AI_AGENT_GLOBAL_MAX_ITERATIONS,
    agentMaxOutputTokens: process.env.AI_AGENT_MAX_OUTPUT_TOKENS,
    agentHistoryMaxMessages: process.env.AI_AGENT_HISTORY_MAX_MESSAGES,
    agentHistoryMaxTokens: process.env.AI_AGENT_HISTORY_MAX_TOKENS,
    agentReasoningEffort: process.env.AI_AGENT_REASONING,
    reportMaxOutputTokens: process.env.AI_REPORT_MAX_OUTPUT_TOKENS,
    reportReasoningEffort: process.env.AI_REPORT_REASONING,
    reportMaxTenderChunks: process.env.AI_REPORT_MAX_TENDER_CHUNKS,
    reportMaxCompanyChunks: process.env.AI_REPORT_MAX_COMPANY_CHUNKS,
    matchEnabled: process.env.AI_MATCH_ENABLED,
    matchRankCap: process.env.AI_MATCH_RANK_CAP,
    matchPoolCap: process.env.AI_MATCH_POOL_CAP,
    matchCandidatesPerFacet: process.env.AI_MATCH_CANDIDATES_PER_FACET,
    matchNumCandidates: process.env.AI_MATCH_NUM_CANDIDATES,
    matchMaxFacets: process.env.AI_MATCH_MAX_FACETS,
    matchJudgeBatch: process.env.AI_MATCH_JUDGE_BATCH,
    matchJudgeConcurrency: process.env.AI_MATCH_JUDGE_CONCURRENCY,
    matchStaleHours: process.env.AI_MATCH_STALE_HOURS,
    matchLexical: process.env.AI_MATCH_LEXICAL,
    matchRuleArmWeight: process.env.AI_MATCH_W_RULE_ARM,
    matchTextArmWeight: process.env.AI_MATCH_W_TEXT_ARM,
    matchPipelineVersion: process.env.MATCH_PIPELINE_VERSION,
    matchProfileVersion: process.env.COMPANY_PROFILE_VERSION,
    extractionMaxChunks: process.env.AI_EXTRACTION_MAX_CHUNKS,
    extractionMaxDocChars: process.env.AI_EXTRACTION_MAX_DOC_CHARS,
    extractionRpm: process.env.AI_EXTRACTION_RPM,
    extractionConcurrency: process.env.AI_EXTRACTION_CONCURRENCY,
    gaebParserVersion: process.env.GAEB_PARSER_VERSION,
    gaebFillBatchSize: process.env.AI_GAEB_FILL_BATCH_SIZE,
    gaebFillBatchConcurrency: process.env.AI_GAEB_FILL_BATCH_CONCURRENCY,
    gaebFillMaxPositions: process.env.AI_GAEB_FILL_MAX_POSITIONS,
    gaebFillInlineMaxItems: process.env.AI_GAEB_FILL_INLINE_MAX_ITEMS,
    gaebFillMaxOutputTokens: process.env.AI_GAEB_FILL_MAX_OUTPUT_TOKENS,
    gaebWebPricingEnabled: process.env.AI_GAEB_WEB_PRICING_ENABLED,
    gaebWebPricingMaxLookups: process.env.AI_GAEB_WEB_PRICING_MAX_LOOKUPS,
  });
  return cached;
}

/** Test hook: drop the cache so env overrides take effect. */
export function resetAiEnvCache(): void {
  cached = null;
}

export function requireGeminiApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY is not configured. Add it to .env.local.");
  }
  return key;
}

/** Reasoning effort for a role, or undefined to leave it to the provider. */
export function roleReasoningEffort(role: string): ReasoningEffort | undefined {
  return aiEnv().roleReasoning[role] as ReasoningEffort | undefined;
}

/**
 * Output budget for a role. Falls back to the agent budget rather than
 * throwing: a new role that nobody remembered to size should degrade to a
 * sensible number, not take a surface down.
 */
export function roleMaxOutputTokens(role: string): number {
  const table = aiEnv().roleMaxOutputTokens;
  return table[role] ?? table.agent ?? 16_384;
}
