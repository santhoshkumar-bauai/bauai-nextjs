/**
 * Backfill: text-extract, chunk and embed every existing company document as
 * tenant-scoped AI context. Processes inline (no worker required).
 * Restart-safe via the ai_index_state ledger.
 *
 *   npm run ai:embed:company
 *   npm run ai:embed:company -- --company <companyId>
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { ObjectId } = await import("mongodb");
const { getCompanyFilesCollection, processCompanyDocEmbed } = await import(
  "../lib/ai/company/doc-embedder.ts"
);
const { aiEnv } = await import("../lib/ai/config/env.ts");
const { closeIngestionClient } = await import("../lib/ingestion/db/client.ts");

const companyIndex = process.argv.indexOf("--company");
const companyFilter = companyIndex >= 0 ? process.argv[companyIndex + 1] : null;

const env = aiEnv();

try {
  const companyFiles = await getCompanyFilesCollection();
  const filter: Record<string, unknown> = { category: { $ne: "logo" } };
  if (companyFilter) filter.companyId = new ObjectId(companyFilter);
  const files = await companyFiles.find(filter as never).toArray();
  console.log(`[ai-embed-company] ${files.length} company documents`);

  let done = 0;
  let failed = 0;
  for (const file of files) {
    try {
      await processCompanyDocEmbed({
        kind: "company_doc_embed",
        companyFileId: String(file._id),
        tenantId: String(file.companyId),
        chunkerVersion: env.chunkerVersion,
        embeddingModel: env.embeddingModel,
        embeddingVersion: env.embeddingVersion,
        actorId: "system",
        correlationId: `backfill-${file._id}`,
        attempt: 0,
      });
      done += 1;
    } catch (error) {
      failed += 1;
      console.error(`[ai-embed-company] failed ${file.fileName}: ${String(error)}`);
    }
  }
  console.log(`[ai-embed-company] done=${done} failed=${failed}`);
} finally {
  await closeIngestionClient();
}
