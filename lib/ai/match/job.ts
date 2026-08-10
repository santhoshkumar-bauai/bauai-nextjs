import type { ObjectId } from "mongodb";

import { logger } from "../../ingestion/observability/logger.ts";
import { failRun } from "./runs.ts";
import { refreshCompanyMatches, toRunError } from "./service.ts";

const log = logger.child("ai.match.job");

/**
 * Runs a refresh and guarantees the run document reaches a terminal state.
 *
 * Both entry points funnel through here — the interactive `after()` kick from
 * the refresh route and the BullMQ worker — so a failure is recorded the same
 * way regardless of which one was running, and the page never sits on a
 * `running` row whose process has gone.
 */
export async function runCompanyMatchJob(input: {
  tenantId: ObjectId;
  runId: ObjectId;
}): Promise<void> {
  try {
    await refreshCompanyMatches(input);
  } catch (error) {
    const key = toRunError(error);
    log.error("match refresh failed", {
      tenantId: input.tenantId.toHexString(),
      error: key,
      message: error instanceof Error ? error.message : String(error),
    });
    await failRun(input.tenantId, key).catch(() => {});
  }
}
