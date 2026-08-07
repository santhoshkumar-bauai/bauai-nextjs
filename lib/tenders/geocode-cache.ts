/**
 * Cheap, lazy geocoding for tender map markers.
 *
 * Tenders have no coordinates yet (the geocoding enrichment stage is
 * unimplemented). Rather than a 36k upfront sweep, we resolve coordinates on
 * demand for only the markers currently being shown, and cache aggressively:
 *
 *  - The `geo_cache` collection is keyed by "<COUNTRY>:<POSTAL>" so every tender
 *    sharing a postal code reuses a single Google call (postal-centroid
 *    granularity is acceptable for markers).
 *  - Successful resolutions are written back onto the tenders themselves
 *    (`buyer.location` + `enrichment.geocoding.status = "DONE"`), so a given
 *    tender is geocoded at most once, ever.
 *  - Failures are remembered with a 7-day TTL to prevent retry storms.
 *  - Each request geocodes at most `MAX_NEW_GEOCODES` new keys, with bounded
 *    concurrency, so a cold region degrades gracefully instead of stampeding.
 */
import { ObjectId, type Collection } from "mongodb";

import { mongoDatabase } from "@/lib/db/mongodb";
import type { TenderDocument } from "@/lib/ingestion/types";

const FAILED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_NEW_GEOCODES = 30;
const CONCURRENCY = 5;

export interface GeoCacheDoc {
  _id: string;
  countryCode: string;
  postalCode?: string;
  city?: string;
  location?: { type: "Point"; coordinates: [number, number] };
  label?: string | null;
  source: "google";
  status: "DONE" | "FAILED";
  failedUntil?: Date;
  hitCount: number;
  createdAt: Date;
  updatedAt: Date;
}

function geoCache(): Collection<GeoCacheDoc> {
  return mongoDatabase.collection<GeoCacheDoc>("geo_cache");
}

let indexPromise: Promise<unknown> | null = null;
/** Idempotent, memoized index creation (TTL on failures + 2dsphere on points). */
function ensureIndexes(): Promise<unknown> {
  if (!indexPromise) {
    indexPromise = geoCache()
      .createIndexes([
        { key: { failedUntil: 1 }, name: "ttl_failed", expireAfterSeconds: 0 },
        { key: { location: "2dsphere" }, name: "ix_location_2dsphere" },
      ])
      .catch(() => {
        // A concurrent creator or a transient error shouldn't break lookups.
        indexPromise = null;
      });
  }
  return indexPromise;
}

export interface MarkerInput {
  /** Tender _id as a hex string. */
  tenderId: string;
  countryCode?: string | null;
  postalCode?: string | null;
  city?: string | null;
  location?: { type: "Point"; coordinates: [number, number] } | null;
}

export interface ResolvedPoint {
  lat: number;
  lng: number;
}

export interface GeoResolveResult {
  coordinates: Map<string, ResolvedPoint>;
  stats: {
    requested: number;
    fromCache: number;
    geocoded: number;
    failed: number;
    skipped: number;
  };
}

type KeyDescriptor =
  | { key: string; kind: "postal"; country: string; postal: string }
  | { key: string; kind: "city"; country: string; city: string };

function deriveKey(input: MarkerInput): KeyDescriptor | null {
  const country = input.countryCode?.trim().toUpperCase();
  if (!country) return null;
  const postal = input.postalCode?.trim();
  if (postal) {
    return { key: `${country}:${postal}`, kind: "postal", country, postal };
  }
  const city = input.city?.trim();
  if (city) {
    return {
      key: `${country}:city:${city.toLowerCase()}`,
      kind: "city",
      country,
      city,
    };
  }
  return null;
}

function pointFromLoc(loc?: {
  coordinates: [number, number];
} | null): ResolvedPoint | null {
  if (!loc?.coordinates) return null;
  const [lng, lat] = loc.coordinates;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return { lat, lng };
}

interface GeocodeResponse {
  status?: string;
  results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }>;
}

/** Returns GeoJSON [lng, lat] on success, or null. */
async function geocode(descriptor: KeyDescriptor): Promise<[number, number] | null> {
  const apiKey = process.env.GOOGLE_MAPS_GEOCODE_API_KEY;
  if (!apiKey) return null;

  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  if (descriptor.kind === "postal") {
    url.searchParams.set(
      "components",
      `country:${descriptor.country}|postal_code:${descriptor.postal}`,
    );
  } else {
    url.searchParams.set("address", descriptor.city);
    url.searchParams.set("components", `country:${descriptor.country}`);
  }
  url.searchParams.set("key", apiKey);

  try {
    const response = await fetch(url, { cache: "no-store" });
    const data = (await response.json()) as GeocodeResponse;
    const loc = data.results?.[0]?.geometry?.location;
    if (
      response.ok &&
      data.status === "OK" &&
      typeof loc?.lat === "number" &&
      typeof loc.lng === "number"
    ) {
      return [loc.lng, loc.lat];
    }
  } catch {
    // Network error — treated as a (soft) failure below.
  }
  return null;
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

/**
 * Resolves coordinates for the given markers, geocoding (cheaply) only what's
 * missing. Returns a per-tender coordinate map plus cost/telemetry stats.
 */
export async function resolveMarkerLocations(
  inputs: MarkerInput[],
): Promise<GeoResolveResult> {
  const coordinates = new Map<string, ResolvedPoint>();
  const stats = { requested: inputs.length, fromCache: 0, geocoded: 0, failed: 0, skipped: 0 };

  // 1. Tenders that already carry their own coordinates need no work.
  const needsKey: MarkerInput[] = [];
  for (const input of inputs) {
    const own = pointFromLoc(input.location);
    if (own) {
      coordinates.set(input.tenderId, own);
      stats.fromCache++;
    } else {
      needsKey.push(input);
    }
  }

  // 2. Group the rest by geo key.
  const keyToTenderIds = new Map<string, string[]>();
  const keyToDescriptor = new Map<string, KeyDescriptor>();
  for (const input of needsKey) {
    const descriptor = deriveKey(input);
    if (!descriptor) {
      stats.skipped++;
      continue;
    }
    keyToDescriptor.set(descriptor.key, descriptor);
    const ids = keyToTenderIds.get(descriptor.key) ?? [];
    ids.push(input.tenderId);
    keyToTenderIds.set(descriptor.key, ids);
  }

  if (keyToDescriptor.size === 0) return { coordinates, stats };

  await ensureIndexes();

  // 3. Look up the cache for every needed key in one round-trip.
  const keys = [...keyToDescriptor.keys()];
  const cached = await geoCache()
    .find({ _id: { $in: keys } })
    .toArray();
  const cacheByKey = new Map(cached.map((doc) => [doc._id, doc]));

  const resolvedKeyCoords = new Map<string, ResolvedPoint>();
  const toGeocode: string[] = [];
  for (const key of keys) {
    const doc = cacheByKey.get(key);
    if (doc?.status === "DONE") {
      const point = pointFromLoc(doc.location);
      if (point) {
        resolvedKeyCoords.set(key, point);
        continue;
      }
    }
    if (doc?.status === "FAILED") continue; // still within TTL — don't retry
    toGeocode.push(key);
  }

  // Increment hit counters best-effort (does not block resolution).
  const cacheHitKeys = keys.filter((key) => resolvedKeyCoords.has(key));
  if (cacheHitKeys.length) {
    void geoCache()
      .updateMany({ _id: { $in: cacheHitKeys } }, { $inc: { hitCount: 1 } })
      .catch(() => undefined);
  }

  // 4. Geocode the misses, hard-capped, with bounded concurrency.
  const capped = toGeocode.slice(0, MAX_NEW_GEOCODES);
  stats.skipped += toGeocode.length - capped.length;

  const now = new Date();
  const tenderUpdates: { key: string; coordinates: [number, number] }[] = [];

  await runWithConcurrency(capped, CONCURRENCY, async (key) => {
    const descriptor = keyToDescriptor.get(key)!;
    const coords = await geocode(descriptor);
    if (coords) {
      resolvedKeyCoords.set(key, { lat: coords[1], lng: coords[0] });
      tenderUpdates.push({ key, coordinates: coords });
      stats.geocoded++;
      await geoCache().updateOne(
        { _id: key },
        {
          $set: {
            countryCode: descriptor.country,
            postalCode: descriptor.kind === "postal" ? descriptor.postal : undefined,
            city: descriptor.kind === "city" ? descriptor.city : undefined,
            location: { type: "Point", coordinates: coords },
            source: "google",
            status: "DONE",
            failedUntil: undefined,
            updatedAt: now,
          },
          $setOnInsert: { createdAt: now, hitCount: 0 },
        },
        { upsert: true },
      );
    } else {
      stats.failed++;
      await geoCache().updateOne(
        { _id: key },
        {
          $set: {
            countryCode: descriptor.country,
            source: "google",
            status: "FAILED",
            failedUntil: new Date(now.getTime() + FAILED_TTL_MS),
            updatedAt: now,
          },
          $setOnInsert: { createdAt: now, hitCount: 0 },
        },
        { upsert: true },
      );
    }
  });

  // 5. Persist freshly geocoded points back onto the shown tenders so they're
  //    never geocoded again. Only postal keys are precise enough to persist.
  const tenders = mongoDatabase.collection<TenderDocument>("tenders");
  for (const update of tenderUpdates) {
    const descriptor = keyToDescriptor.get(update.key);
    if (descriptor?.kind !== "postal") continue;
    const ids = (keyToTenderIds.get(update.key) ?? [])
      .map((id) => {
        try {
          return new ObjectId(id);
        } catch {
          return null;
        }
      })
      .filter((id): id is ObjectId => id !== null);
    if (!ids.length) continue;
    void tenders
      .updateMany(
        { _id: { $in: ids } },
        {
          $set: {
            "buyer.location": { type: "Point", coordinates: update.coordinates },
            "enrichment.geocoding": { status: "DONE", updatedAt: now },
            updatedAt: now,
          },
        },
      )
      .catch(() => undefined);
  }

  // 6. Fan the per-key coordinates back out to each tender.
  for (const [key, ids] of keyToTenderIds) {
    const point = resolvedKeyCoords.get(key);
    if (!point) continue;
    for (const id of ids) coordinates.set(id, point);
  }

  return { coordinates, stats };
}
