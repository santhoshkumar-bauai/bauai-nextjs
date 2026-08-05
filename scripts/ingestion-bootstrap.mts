/**
 * Phase 1 setup (§19): create collections, indexes, and source configs, then verify
 * source access. Idempotent — safe to run on every deploy.
 *
 *   npm run ingestion:bootstrap
 *   npm run ingestion:bootstrap -- --skip-access
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { assertReplicaSet, closeIngestionClient } = await import(
  "../lib/ingestion/db/client.ts"
);
const { ensureIngestionIndexes } = await import("../lib/ingestion/db/indexes.ts");
const { ensureRawStoreIndexes, checkRawStoreAccess } = await import(
  "../lib/ingestion/storage/raw-payload-store.ts"
);
const { seedSourceConfigs, loadEnabledConfigs } = await import(
  "../lib/ingestion/scheduler/source-configs.ts"
);
const { createAdapter } = await import("../lib/ingestion/sources/registry.ts");
const { assertS3Configured } = await import("../lib/ingestion/config/env.ts");

const skipAccess = process.argv.includes("--skip-access");
let failures = 0;

try {
  await assertReplicaSet();
  console.log("[ok] MongoDB is a replica set; transactions and change streams available");

  await ensureIngestionIndexes();
  await ensureRawStoreIndexes();
  console.log("[ok] collections and indexes ensured");

  try {
    assertS3Configured();
    console.log("[ok] S3 raw payload storage configured");

    // Writes and deletes one small probe object; opt in, because bootstrap runs on
    // every deploy and this is the only step with an external side effect.
    if (process.argv.includes("--check-storage")) {
      const storage = await checkRawStoreAccess();
      if (storage.ok) {
        console.log(`[ok] raw payload store round trip: ${storage.detail}`);
      } else {
        failures += 1;
        console.error(`[fail] raw payload store: ${storage.detail}`);
      }
    }
  } catch (error) {
    failures += 1;
    console.error(`[fail] ${String(error)}`);
  }

  const seeded = await seedSourceConfigs();
  console.log(
    seeded.length
      ? `[ok] seeded source configs: ${seeded.join(", ")}`
      : "[ok] source configs already present; existing intervals left untouched",
  );

  const configs = await loadEnabledConfigs();
  console.log(`[ok] enabled sources: ${configs.map((c) => c._id).join(", ") || "none"}`);

  if (!skipAccess) {
    // Phase 0 gate: every required endpoint must answer from the deployment region.
    for (const config of configs) {
      const report = await createAdapter(config).checkAccess();
      if (report.reachable) {
        console.log(`[ok] ${report.source}: ${report.detail}`);
      } else {
        failures += 1;
        console.error(`[fail] ${report.source}: ${report.detail}`);
      }
    }
  }
} finally {
  await closeIngestionClient();
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nBootstrap complete.");
