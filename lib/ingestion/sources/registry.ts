import { permanent } from "../http/errors.ts";
import type {
  SourceConfigDocument,
  TenderSourceAdapter,
  TenderSourceCode,
} from "../types.ts";
import { GermanyAdapter } from "./germany/adapter.ts";
import { TedAdapter } from "./ted/adapter.ts";

type AdapterFactory = (config: SourceConfigDocument) => TenderSourceAdapter;

/**
 * Adapters available to the workers. Section 3.3 requires one source to clear
 * access verification, fixtures, backfill, live polling, and reconciliation
 * before the next is enabled, so wave 1-3 sources are added here one at a time.
 */
const factories: Partial<Record<TenderSourceCode, AdapterFactory>> = {
  DE_BUND: (config) => new GermanyAdapter(config),
  TED: (config) => new TedAdapter(config),
};

/** Adapters are cheap but hold a rate limiter, so one instance per source is reused. */
const instances = new Map<TenderSourceCode, TenderSourceAdapter>();

export function createAdapter(config: SourceConfigDocument): TenderSourceAdapter {
  const cached = instances.get(config._id);
  if (cached) return cached;

  const factory = factories[config._id];
  if (!factory) {
    throw permanent(`No ingestion adapter is registered for source ${config._id}`);
  }

  const adapter = factory(config);
  instances.set(config._id, adapter);
  return adapter;
}

export function registeredSourceCodes(): TenderSourceCode[] {
  return Object.keys(factories) as TenderSourceCode[];
}

export function hasAdapter(code: string): code is TenderSourceCode {
  return code in factories;
}

/** Called on config reload so a changed interval or rate limit takes effect. */
export function resetAdapterCache(): void {
  instances.clear();
}
