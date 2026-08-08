import { Worker, type Job } from "bullmq";

import { logger } from "../../ingestion/observability/logger.ts";
import { aiEnv } from "../config/env.ts";
import { aiRedisOptions } from "../queue/connection.ts";
import { AI_QUEUES, closeAiQueues } from "../queue/queues.ts";
import { aiJobSchema, type AiJob } from "../queue/jobs.ts";

const log = logger.child("ai.indexer");

/** Processors register per job kind; phases 6/7 fill this in. */
export type JobProcessor = (job: AiJob, signal: AbortSignal) => Promise<void>;

/** Producers run alongside consumers until the signal aborts (sweeps, subscriptions). */
export type Producer = (signal: AbortSignal) => Promise<void>;

export class AiIndexer {
  private readonly processors = new Map<AiJob["kind"], JobProcessor>();
  private readonly producers: Producer[] = [];
  private workers: Worker[] = [];
  private healthy = false;

  registerProcessor(kind: AiJob["kind"], processor: JobProcessor): void {
    this.processors.set(kind, processor);
  }

  registerProducer(producer: Producer): void {
    this.producers.push(producer);
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async start(signal: AbortSignal): Promise<void> {
    const env = aiEnv();

    const embeddingWorker = new Worker(
      AI_QUEUES.embedding,
      async (job: Job) => this.process(job, signal),
      {
        connection: aiRedisOptions(),
        prefix: env.redisPrefix,
        concurrency: env.workerConcurrency,
        // One shared budget for every Gemini embedding call (§10.4).
        limiter: { max: env.embeddingRpm, duration: 60_000 },
      },
    );
    // Extraction jobs fan out to several generation calls each, so the
    // limiter and concurrency are deliberately tighter.
    const extractionWorker = new Worker(
      AI_QUEUES.extraction,
      async (job: Job) => this.process(job, signal),
      {
        connection: aiRedisOptions(),
        prefix: env.redisPrefix,
        concurrency: env.extractionConcurrency,
        limiter: { max: env.extractionRpm, duration: 60_000 },
      },
    );
    for (const [queue, worker] of [
      [AI_QUEUES.embedding, embeddingWorker],
      [AI_QUEUES.extraction, extractionWorker],
    ] as const) {
      worker.on("failed", (job, error) => {
        log.error("job failed", {
          queue,
          jobId: job?.id,
          attempt: job?.attemptsMade,
          error: error.message,
        });
      });
    }
    this.workers = [embeddingWorker, extractionWorker];

    this.healthy = true;
    log.info("ai-indexer started", {
      queues: [AI_QUEUES.embedding, AI_QUEUES.extraction],
      concurrency: env.workerConcurrency,
      rpm: env.embeddingRpm,
      producers: this.producers.length,
    });

    const producerRuns = this.producers.map((producer) =>
      producer(signal).catch((error) => {
        log.error("producer crashed", { error: String(error) });
        this.healthy = false;
        throw error;
      }),
    );

    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });

    await Promise.allSettled(producerRuns);
  }

  private async process(job: Job, signal: AbortSignal): Promise<void> {
    const parsed = aiJobSchema.safeParse(job.data);
    if (!parsed.success) {
      // A malformed payload never becomes valid — fail without retry noise.
      log.error("invalid job payload", { jobId: job.id, error: parsed.error.message });
      throw new Error(`invalid ai job payload: ${parsed.error.message}`);
    }
    const processor = this.processors.get(parsed.data.kind);
    if (!processor) {
      throw new Error(`no processor registered for job kind "${parsed.data.kind}"`);
    }
    await processor(parsed.data, signal);
  }

  async stop(): Promise<void> {
    this.healthy = false;
    await Promise.allSettled(this.workers.map((worker) => worker.close()));
    this.workers = [];
    await closeAiQueues();
  }
}
