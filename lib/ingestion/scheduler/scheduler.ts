import { ingestionEnv } from "../config/env.ts";
import { describeError, logger } from "../observability/logger.ts";
import { deadLetterDepth } from "../pipeline/dead-letter.ts";
import { expireStaleRuns, startRun } from "../pipeline/runs.ts";
import { queuePriority } from "../queue/channels.ts";
import { StreamQueue } from "../queue/stream-queue.ts";
import { sweepOrphanPayloads } from "../storage/raw-payload-store.ts";
import type { IngestionMode, QueueName, SourceConfigDocument } from "../types.ts";
import { addDays, sleep, startOfUtcDay } from "../utils/time.ts";
import {
  isDue,
  isProbeDue,
  loadCheckpoint,
  markCheckpointFailure,
  markCheckpointSuccess,
  scheduleNextRun,
  setCheckpointWindow,
  toCursor,
} from "./checkpoints.ts";
import { runDiscovery } from "./discovery.ts";
import { withLease } from "./lease.ts";
import { loadEnabledConfigs, seedSourceConfigs } from "./source-configs.ts";

const log = logger.child("scheduler");

const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Long-lived recurring-job scheduler (architecture section 5.1).
 *
 * Deliberately not a crontab: intervals live in MongoDB so they are remotely
 * configurable, the next run time is persisted so a restart cannot lose it, and a
 * lease guarantees one replica per source. Live and reconciliation schedules are
 * independent; backfill partitions are enqueued separately and executed by the
 * ingest workers off the low-priority queue.
 */
export class SourceScheduler {
  private readonly queue = new StreamQueue(`scheduler-${ingestionEnv.workerId}`);
  private lastMaintenanceAt = 0;
  private lastTickAt = Date.now();
  private stopped = false;

  async start(signal: AbortSignal): Promise<void> {
    await seedSourceConfigs();
    log.info("scheduler started", { tickMs: ingestionEnv.scheduler.tickIntervalMs });

    while (!signal.aborted && !this.stopped) {
      try {
        await this.tick(signal);
      } catch (error) {
        log.error("scheduler tick failed", describeError(error));
      }
      this.lastTickAt = Date.now();
      await sleep(ingestionEnv.scheduler.tickIntervalMs, signal);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /** Health is "the loop is still turning", not "every source is succeeding". */
  isHealthy(): boolean {
    return (
      !this.stopped &&
      Date.now() - this.lastTickAt < ingestionEnv.scheduler.tickIntervalMs * 4
    );
  }

  async close(): Promise<void> {
    await this.queue.close();
  }

  private async tick(signal: AbortSignal): Promise<void> {
    const configs = await loadEnabledConfigs();

    for (const config of configs) {
      if (signal.aborted) return;
      await this.maybeRun(config, "live", "live", signal);
      await this.maybeRun(config, "reconciliation", "reconciliation", signal);
    }

    await this.maintenance();
    await this.reportQueueDepths();
  }

  private async maybeRun(
    config: SourceConfigDocument,
    mode: IngestionMode,
    targetQueue: QueueName,
    signal: AbortSignal,
  ): Promise<void> {
    const checkpoint = await loadCheckpoint(config._id, mode);

    // While a circuit is open the source is probed on its normal schedule rather
    // than hammered; only once the probe window has elapsed does it run again.
    if (!isDue(checkpoint) && !isProbeDue(checkpoint)) return;

    const intervalSeconds =
      mode === "live"
        ? config.liveIntervalSeconds
        : config.reconciliationIntervalSeconds;

    // Reserve the slot before doing any work so a slow run cannot be started
    // twice by two ticks of the same scheduler.
    await scheduleNextRun(config._id, mode, intervalSeconds, config.jitterRatio);

    if (mode === "reconciliation") {
      const to = startOfUtcDay(new Date());
      await setCheckpointWindow(
        config._id,
        mode,
        addDays(to, -config.reconciliationDays),
        addDays(to, 1),
      );
    }

    const ran = await withLease(config._id, mode, async () => {
      const fresh = await loadCheckpoint(config._id, mode);
      const run = await startRun({
        source: config._id,
        mode,
        partition: fresh.pageOrToken,
        windowFrom: fresh.windowFrom,
        windowTo: fresh.windowTo,
        parserVersion: config.parserVersion,
      });

      try {
        const outcome = await runDiscovery({
          config,
          mode,
          cursor: toCursor(fresh, config.overlapSeconds),
          queue: this.queue,
          targetQueue,
          run,
          signal,
        });

        if (outcome.unchanged && outcome.discovered === 0) {
          await run.markUnchanged();
        } else {
          await run.succeed({ httpStatus: outcome.httpStatus });
        }
        await markCheckpointSuccess(config._id, mode);
        return outcome;
      } catch (error) {
        await run.fail(error);
        const state = await markCheckpointFailure(
          config._id,
          mode,
          config.circuitBreakerThreshold,
        );
        log.error("discovery failed", {
          source: config._id,
          mode,
          consecutiveFailures: state.consecutiveFailures,
          circuitOpen: state.circuitOpen,
          ...describeError(error),
        });
        return null;
      }
    });

    if (ran === null) {
      log.debug("another replica holds the lease", { source: config._id, mode });
    }
  }

  /**
   * Periodic housekeeping: stale run expiry, orphan payload sweeping, and the
   * dead-letter depth gauge the section 15.3 alerts read.
   */
  private async maintenance(): Promise<void> {
    if (Date.now() - this.lastMaintenanceAt < MAINTENANCE_INTERVAL_MS) return;
    this.lastMaintenanceAt = Date.now();

    const results = await Promise.allSettled([
      expireStaleRuns(),
      deadLetterDepth(),
      sweepOrphanPayloads(),
    ]);

    for (const result of results) {
      if (result.status === "rejected") {
        log.error("maintenance task failed", { reason: String(result.reason) });
      }
    }
  }

  private async reportQueueDepths(): Promise<void> {
    for (const queue of queuePriority) {
      try {
        await this.queue.stats(queue);
      } catch (error) {
        log.error("failed to read queue stats", { queue, error: String(error) });
      }
    }
  }
}
