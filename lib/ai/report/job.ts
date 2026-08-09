import type { ObjectId } from "mongodb";

import type { CompanyContext } from "../../company/context.ts";
import { logger } from "../../ingestion/observability/logger.ts";
import type { SerializedTenderDetail } from "../../tenders/detail.ts";
import { RateLimitError, StructuredOutputError } from "../gateway/types.ts";
import {
  finishRun,
  heartbeat,
  markStage,
  RUN_HEARTBEAT_MS,
} from "./runs.ts";
import type { ReportLocale } from "./schema.ts";
import { generateTenderReport } from "./service.ts";

const log = logger.child("ai.report.job");

/**
 * Runs one report generation to completion, recording its progress in the run
 * document.
 *
 * Deliberately takes no AbortSignal: the caller's request is long gone by the
 * time this finishes, and a reader closing their tab must not throw away a
 * minutes-long, already-paid-for generation. The run record is what the page
 * watches, so the work is useful even if nobody is looking when it lands.
 */
export async function runReportJob(input: {
  companyContext: CompanyContext;
  tenantId: ObjectId;
  tenderId: ObjectId;
  tender: SerializedTenderDetail;
  locale: ReportLocale;
}): Promise<void> {
  // Long stages ("analyzing" can run for minutes) emit no progress of their
  // own, so the claim is kept alive independently.
  const pulse = setInterval(() => {
    void heartbeat(input.tenantId, input.tenderId).catch(() => undefined);
  }, RUN_HEARTBEAT_MS);

  try {
    await generateTenderReport({
      companyContext: input.companyContext,
      tenderId: input.tenderId,
      tender: input.tender,
      locale: input.locale,
      onProgress: (stage) => {
        void markStage(input.tenantId, input.tenderId, stage).catch(
          () => undefined,
        );
      },
    });
    await finishRun({
      tenantId: input.tenantId,
      tenderId: input.tenderId,
      error: null,
    });
  } catch (error) {
    log.error("report job failed", {
      tenderId: String(input.tenderId),
      error: error instanceof Error ? error.message : String(error),
    });
    await finishRun({
      tenantId: input.tenantId,
      tenderId: input.tenderId,
      error: errorCode(error),
    }).catch(() => undefined);
  } finally {
    clearInterval(pulse);
  }
}

/** Collapses provider failures to i18n keys — never a raw provider message. */
function errorCode(error: unknown): string {
  if (error instanceof RateLimitError) return "rate_limited";
  if (error instanceof StructuredOutputError) return "invalid_output";
  if (error instanceof Error && /rate.?limit/i.test(error.message)) {
    return "rate_limited";
  }
  return "failed";
}
