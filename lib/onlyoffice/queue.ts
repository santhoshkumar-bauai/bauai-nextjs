import { Queue, type JobsOptions } from "bullmq";

import { aiRedisOptions } from "@/lib/ai/queue/connection";

export const ONLYOFFICE_CONVERSION_QUEUE = "onlyoffice-conversion";
export const ONLYOFFICE_QUEUE_PREFIX = process.env.ONLYOFFICE_REDIS_PREFIX || "{bauai:onlyoffice}";

export type OnlyOfficeConversionJob = {
  kind: "convert";
  documentId: string;
};

const options: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: 500,
  removeOnFail: 2_000,
};

let queue: Queue<OnlyOfficeConversionJob> | null = null;

export function onlyOfficeConversionQueue(): Queue<OnlyOfficeConversionJob> {
  queue ??= new Queue<OnlyOfficeConversionJob>(ONLYOFFICE_CONVERSION_QUEUE, {
    connection: aiRedisOptions(),
    prefix: ONLYOFFICE_QUEUE_PREFIX,
    defaultJobOptions: options,
  });
  return queue;
}

export async function enqueueOnlyOfficeConversion(documentId: string): Promise<void> {
  await onlyOfficeConversionQueue().add(
    "convert",
    { kind: "convert", documentId },
    { jobId: `convert-${documentId}` },
  );
}
