import { Queue, type JobsOptions } from "bullmq";

import { aiRedisOptions } from "@/lib/ai/queue/connection";

export const ONLYOFFICE_CONVERSION_QUEUE = "onlyoffice-conversion";
export const ONLYOFFICE_QUEUE_PREFIX = process.env.ONLYOFFICE_REDIS_PREFIX || "{bauai:onlyoffice}";

export type OnlyOfficeJob =
  | { kind: "convert"; documentId: string }
  | { kind: "fill-analyze"; runId: string }
  | { kind: "fill-generate"; runId: string };

const options: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: 500,
  removeOnFail: 2_000,
};

let queue: Queue<OnlyOfficeJob> | null = null;

export function onlyOfficeConversionQueue(): Queue<OnlyOfficeJob> {
  queue ??= new Queue<OnlyOfficeJob>(ONLYOFFICE_CONVERSION_QUEUE, {
    connection: aiRedisOptions(),
    prefix: ONLYOFFICE_QUEUE_PREFIX,
    defaultJobOptions: options,
  });
  return queue;
}

export async function enqueueDocumentFillAnalysis(runId: string): Promise<void> {
  await onlyOfficeConversionQueue().add(
    "fill-analyze",
    { kind: "fill-analyze", runId },
    { jobId: `fill-analyze-${runId}` },
  );
}

export async function enqueueDocumentFillGeneration(runId: string): Promise<void> {
  await onlyOfficeConversionQueue().add(
    "fill-generate",
    { kind: "fill-generate", runId },
    { jobId: `fill-generate-${runId}` },
  );
}

export async function enqueueOnlyOfficeConversion(documentId: string): Promise<void> {
  await onlyOfficeConversionQueue().add(
    "convert",
    { kind: "convert", documentId },
    { jobId: `convert-${documentId}` },
  );
}
