import { sourceDefaults } from "../config/source-defaults.ts";
import { getCollections } from "../db/collections.ts";
import { logger } from "../observability/logger.ts";
import { registeredSourceCodes, resetAdapterCache } from "../sources/registry.ts";
import type { SourceConfigDocument, TenderSourceCode } from "../types.ts";

const log = logger.child("source-configs");

/**
 * Seeds `source_configs` with the section 4 starting values. Existing documents are
 * left untouched: once a source is live, its intervals are owned by operations,
 * not by a redeploy (§4.1).
 */
export async function seedSourceConfigs(): Promise<TenderSourceCode[]> {
  const collections = await getCollections();
  const seeded: TenderSourceCode[] = [];

  for (const code of registeredSourceCodes()) {
    const defaults = sourceDefaults[code];
    if (!defaults) continue;

    const result = await collections.sourceConfigs.updateOne(
      { _id: code },
      { $setOnInsert: { ...defaults, updatedAt: new Date() } },
      { upsert: true },
    );
    if (result.upsertedCount) seeded.push(code);
  }

  if (seeded.length) log.info("seeded source configs", { sources: seeded });
  return seeded;
}

/**
 * Loads enabled configs for sources that actually have an adapter. A config left
 * enabled for a source whose adapter was removed is skipped loudly rather than
 * crashing the scheduler loop.
 */
export async function loadEnabledConfigs(): Promise<SourceConfigDocument[]> {
  const collections = await getCollections();
  const configs = await collections.sourceConfigs.find({ enabled: true }).toArray();

  const usable: SourceConfigDocument[] = [];
  for (const config of configs) {
    if (!registeredSourceCodes().includes(config._id)) {
      log.warn("skipping enabled source without a registered adapter", {
        source: config._id,
      });
      continue;
    }
    usable.push(config);
  }
  return usable;
}

export async function getSourceConfig(
  code: TenderSourceCode,
): Promise<SourceConfigDocument | null> {
  const collections = await getCollections();
  return collections.sourceConfigs.findOne({ _id: code });
}

/**
 * Applies an operational change. Clearing the adapter cache is required because
 * adapters capture the rate limiter and timeouts at construction.
 */
export async function updateSourceConfig(
  code: TenderSourceCode,
  patch: Partial<Omit<SourceConfigDocument, "_id">>,
): Promise<void> {
  const collections = await getCollections();
  await collections.sourceConfigs.updateOne(
    { _id: code },
    { $set: { ...patch, updatedAt: new Date() } },
  );
  resetAdapterCache();
  log.info("source config updated", { source: code, fields: Object.keys(patch) });
}
