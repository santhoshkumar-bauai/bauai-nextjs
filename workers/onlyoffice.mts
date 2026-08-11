import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { Worker } = await import("bullmq");
const { aiRedisOptions } = await import("../lib/ai/queue/connection.ts");
const { convertWorkspaceDocument } = await import("../lib/onlyoffice/conversion.ts");
const {
  ONLYOFFICE_CONVERSION_QUEUE,
  ONLYOFFICE_QUEUE_PREFIX,
} = await import("../lib/onlyoffice/queue.ts");
const { reconcileOnlyOfficeState } = await import("../lib/onlyoffice/reconcile.ts");

const worker = new Worker(
  ONLYOFFICE_CONVERSION_QUEUE,
  async (job) => {
    if (job.data.kind !== "convert") return;
    await convertWorkspaceDocument(job.data.documentId);
  },
  {
    connection: aiRedisOptions(),
    prefix: ONLYOFFICE_QUEUE_PREFIX,
    concurrency: Number(process.env.ONLYOFFICE_CONVERSION_CONCURRENCY || 2),
  },
);

const reconciliation = setInterval(() => {
  void reconcileOnlyOfficeState().catch((error) =>
    console.error("ONLYOFFICE reconciliation failed", error),
  );
}, 60_000);
void reconcileOnlyOfficeState().catch((error) =>
  console.error("Initial ONLYOFFICE reconciliation failed", error),
);

const shutdown = async () => {
  clearInterval(reconciliation);
  await worker.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await new Promise(() => undefined);
