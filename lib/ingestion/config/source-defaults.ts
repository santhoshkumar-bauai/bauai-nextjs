import type { SourceConfigDocument, TenderSourceCode } from "../types.ts";

/**
 * Starting values from architecture section 4. These are seeded into
 * `source_configs` once and are then owned by operations: the scheduler reads
 * MongoDB on every tick so intervals change without a redeployment (§4.1).
 */
type SourceDefault = Omit<SourceConfigDocument, "_id" | "updatedAt">;

export const sourceDefaults: Record<TenderSourceCode, SourceDefault | undefined> = {
  DE_BUND: {
    enabled: true,
    priority: "required",
    liveIntervalSeconds: 300,
    reconciliationIntervalSeconds: 86_400,
    overlapSeconds: 3_600,
    maxConcurrentRequests: 2,
    requestTimeoutMs: 120_000,
    rateLimitPerMinute: 20,
    reconciliationDays: 7,
    backfillHorizonMonths: 24,
    jitterRatio: 0.2,
    circuitBreakerThreshold: 5,
    parserVersion: "eforms-de-1.0.0",
    licence: "dl-de-by-2.0",
  },
  TED: {
    enabled: true,
    priority: "required",
    liveIntervalSeconds: 120,
    reconciliationIntervalSeconds: 86_400,
    overlapSeconds: 1_800,
    maxConcurrentRequests: 2,
    requestTimeoutMs: 30_000,
    rateLimitPerMinute: 20,
    reconciliationDays: 7,
    backfillHorizonMonths: 24,
    jitterRatio: 0.2,
    circuitBreakerThreshold: 5,
    parserVersion: "ted-search-1.0.0",
    licence: "eu-reuse-2011-833",
  },
  // Wave 1-3 sources are registered only once their adapter passes the access,
  // fixture, backfill and reconciliation gates in section 19.
  NL_TENDERNED: undefined,
  FR_BOAMP: undefined,
  ES_PLACSP: undefined,
  PL_BZP: undefined,
  UK_FTS: undefined,
  UK_CF: undefined,
  PT_BASE: undefined,
  IT_ANAC: undefined,
  IE_ETENDERS: undefined,
};
