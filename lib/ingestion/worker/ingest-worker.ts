import { ingestionEnv } from "../config/env.ts";
import { IngestionError, parseRetryAfterFallback } from "./retry-policy.ts";
import { describeError, logger } from "../observability/logger.ts";
import { metrics } from "../observability/metrics.ts";
import { recordDeadLetter } from "../pipeline/dead-letter.ts";
import { processNoticeJob } from "../pipeline/process-notice.ts";
import { startRun } from "../pipeline/runs.ts";
import { queuePriority } from "../queue/channels.ts";
import { StreamQueue, type ReservedMessage } from "../queue/stream-queue.ts";
import { runDiscovery } from "../scheduler/discovery.ts";
import { getSourceConfig } from "../scheduler/source-configs.ts";
import { liveStaleness } from "../scheduler/checkpoints.ts";
import type {
  DiscoveryJob,
  IngestionJob,
  NoticeJob,
  QueueName,
  SourceConfigDocument,
} from "../types.ts";
import { sleep } from "../utils/time.ts";

const log = logger.child("worker");

const IDLE_BLOCK_MS = 5_000;
const RECLAIM_INTERVAL_MS = 30_000;

/**
 * Ingest worker: consumes notice and discovery jobs from the durable queues.
 *
 * Priority is strict (live > reconciliation > enrichment > backfill) and backfill
 * is additionally gated on live health, so seeding history can never delay current
 * tenders (§9.4). Shutdown stops taking new work and finishes what is in flight.
 */
export class IngestWorker {
  private readonly queue = new StreamQueue();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly configCache = new Map<string, { config: SourceConfigDocument; at: number }>();
  private lastReclaimAt = 0;
  private lastLoopAt = Date.now();
  private backfillPaused = false;
  private stopped = false;

  async start(signal: AbortSignal): Promise<void> {
    log.info("ingest worker started", {
      concurrency: ingestionEnv.worker.concurrency,
      queues: queuePriority,
    });

    while (!signal.aborted && !this.stopped) {
      this.lastLoopAt = Date.now();
      try {
        await this.loop(signal);
      } catch (error) {
        log.error("worker loop failed", describeError(error));
        await sleep(1_000, signal);
      }
    }

    await this.drain();
  }

  stop(): void {
    this.stopped = true;
  }

  isHealthy(): boolean {
    return !this.stopped && Date.now() - this.lastLoopAt < 120_000;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }

  private async loop(signal: AbortSignal): Promise<void> {
    const free = ingestionEnv.worker.concurrency - this.inFlight.size;
    if (free <= 0) {
      // Wait for a slot rather than spinning; any settled task frees one.
      await Promise.race(this.inFlight);
      return;
    }

    await this.reclaimStalled();
    await this.refreshBackfillGate();

    for (const queue of this.eligibleQueues()) {
      await this.queue.promoteDueRetries(queue);

      const capacity = ingestionEnv.worker.concurrency - this.inFlight.size;
      if (capacity <= 0) return;

      // Only the lowest-priority queue blocks, so a live job arriving while the
      // worker waits on `backfill` is picked up on the very next iteration.
      const isLast = queue === this.eligibleQueues().at(-1);
      const messages = await this.queue.reserve(
        queue,
        capacity,
        isLast ? IDLE_BLOCK_MS : 0,
      );

      if (!messages.length) continue;

      for (const message of messages) {
        this.track(this.handle(message, signal));
      }
      return;
    }

    await sleep(250, signal);
  }

  private eligibleQueues(): QueueName[] {
    return queuePriority.filter(
      (queue) => queue !== "backfill" || !this.backfillPaused,
    );
  }

  /**
   * Pauses backfill when live ingestion is behind its SLO, which is the section 9.4
   * requirement that live work always wins.
   */
  private async refreshBackfillGate(): Promise<void> {
    try {
      const staleness = await liveStaleness();
      const breached = staleness.some(
        (entry) => entry.staleMs > ingestionEnv.scheduler.liveLatencySloMs,
      );

      if (breached !== this.backfillPaused) {
        log[breached ? "warn" : "info"]("backfill gate changed", { paused: breached });
      }
      this.backfillPaused = breached;
      metrics.gauge("ingestion_backfill_paused", breached ? 1 : 0);
    } catch (error) {
      log.error("failed to evaluate backfill gate", describeError(error));
    }
  }

  private async reclaimStalled(): Promise<void> {
    if (Date.now() - this.lastReclaimAt < RECLAIM_INTERVAL_MS) return;
    this.lastReclaimAt = Date.now();

    for (const queue of queuePriority) {
      const messages = await this.queue.reclaimStalled(queue, 20);
      for (const message of messages) {
        this.track(this.handle(message, new AbortController().signal));
      }
    }
  }

  private track(promise: Promise<void>): void {
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise));
  }

  /** Finishes in-flight jobs instead of abandoning them to a redelivery timeout. */
  private async drain(): Promise<void> {
    if (!this.inFlight.size) return;
    log.info("draining in-flight jobs", { count: this.inFlight.size });

    const deadline = sleep(ingestionEnv.worker.shutdownGraceMs);
    await Promise.race([Promise.allSettled([...this.inFlight]), deadline]);

    if (this.inFlight.size) {
      log.warn("shutdown grace elapsed with jobs still running; they will be redelivered", {
        count: this.inFlight.size,
      });
    }
  }

  private async handle(message: ReservedMessage, signal: AbortSignal): Promise<void> {
    const { job } = message;
    const heartbeat = setInterval(() => {
      void this.queue.heartbeat(message.queue, message).catch(() => undefined);
    }, ingestionEnv.worker.heartbeatIntervalMs);

    try {
      const config = await this.resolveConfig(job);
      if (!config) {
        // A job for a disabled or unregistered source is dropped rather than
        // retried forever, but is recorded so it is never silently lost.
        await recordDeadLetter({
          job,
          error: new Error(`No enabled source config for ${job.source}`),
          attempts: message.attempt,
          parserVersion: "unknown",
        });
        await this.queue.ack(message.queue, message.id);
        return;
      }

      if (job.kind === "notice") await this.handleNotice(job, config, message);
      else await this.handleDiscovery(job, config, message, signal);

      await this.queue.ack(message.queue, message.id);
    } catch (error) {
      await this.handleFailure(message, error);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async handleNotice(
    job: NoticeJob,
    config: SourceConfigDocument,
    message: ReservedMessage,
  ): Promise<void> {
    const result = await processNoticeJob(job, config);
    log.debug("notice job finished", {
      jobKey: job.jobKey,
      outcome: result.outcome,
      attempt: message.attempt,
    });
  }

  /**
   * Backfill partitions arrive as discovery jobs so any worker can expand one into
   * notice jobs. The partition's own window is used, and the live cursor is never
   * touched (§9.4).
   */
  private async handleDiscovery(
    job: DiscoveryJob,
    config: SourceConfigDocument,
    message: ReservedMessage,
    signal: AbortSignal,
  ): Promise<void> {
    const windowFrom = job.windowFrom ? new Date(job.windowFrom) : null;
    const windowTo = job.windowTo ? new Date(job.windowTo) : null;

    const run = await startRun({
      source: config._id,
      mode: job.mode,
      partition: job.partition,
      windowFrom,
      windowTo,
      parserVersion: config.parserVersion,
    });

    try {
      const outcome = await runDiscovery({
        config,
        mode: job.mode,
        cursor: {
          source: config._id,
          mode: job.mode,
          watermark: null,
          pageOrToken: null,
          lastOfficialId: null,
          windowFrom,
          windowTo,
          etag: null,
          lastModified: null,
        },
        queue: this.queue,
        // Notices found by a backfill partition stay on the low-priority queue.
        targetQueue: job.mode === "backfill" ? "backfill" : "reconciliation",
        run,
        signal,
      });

      await run.succeed({ httpStatus: outcome.httpStatus });
      log.info("partition expanded", {
        partition: job.partition,
        discovered: outcome.discovered,
        accepted: outcome.accepted,
        attempt: message.attempt,
      });
    } catch (error) {
      await run.fail(error);
      throw error;
    }
  }

  /**
   * Applies the section 11.1 retry table: honour `Retry-After`, back off on
   * transient failures, and dead-letter anything permanent or out of attempts.
   */
  private async handleFailure(message: ReservedMessage, error: unknown): Promise<void> {
    const { job } = message;
    const retryable = error instanceof IngestionError ? error.retryable : true;
    const outOfAttempts = message.attempt >= ingestionEnv.worker.maxAttempts;

    if (!retryable || outOfAttempts) {
      await recordDeadLetter({
        job,
        error,
        attempts: message.attempt,
        parserVersion: this.configCache.get(job.source)?.config.parserVersion ?? "unknown",
        rawPayload: job.kind === "notice" ? (job.stagedPayload ?? null) : null,
        runId: job.kind === "notice" ? job.runId : null,
      });
      await this.queue.ack(message.queue, message.id);
      return;
    }

    const delayMs = parseRetryAfterFallback(error, message.attempt);
    log.warn("job failed; scheduling retry", {
      jobKey: job.jobKey,
      attempt: message.attempt,
      delayMs,
      ...describeError(error),
    });
    await this.queue.retryLater(message.queue, message, delayMs);
  }

  /** Cached briefly so every job does not re-read `source_configs`. */
  private async resolveConfig(job: IngestionJob): Promise<SourceConfigDocument | null> {
    const cached = this.configCache.get(job.source);
    if (cached && Date.now() - cached.at < 30_000) return cached.config;

    const config = await getSourceConfig(job.source);
    if (!config?.enabled) return null;

    this.configCache.set(job.source, { config, at: Date.now() });
    return config;
  }
}
