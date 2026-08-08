/**
 * Geocoding backfill: resolves `buyer.location` for tenders whose geocoding
 * enrichment is PENDING, at postal-code-centroid granularity, sharing the
 * same `geo_cache` collection as the on-demand map geocoder — every postal
 * key is paid for at most once, ever.
 *
 *   npm run geocode:backfill                 # biddable tenders only (default)
 *   npm run geocode:backfill -- --all        # entire corpus
 *   npm run geocode:backfill -- --dry        # count + cost estimate, no API calls
 *   npm run geocode:backfill -- --limit 10   # probe run
 *
 * Tenders without any usable address are marked SKIPPED so they leave the
 * pending pool. Failures are cached with a 7-day TTL (same as the map path).
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { getIngestionDb, closeIngestionClient } = await import(
  "../lib/ingestion/db/client.ts"
);

interface GeoPoint {
  type: "Point";
  coordinates: [number, number];
}

const args = process.argv.slice(2);
const all = args.includes("--all");
const dry = args.includes("--dry");
const limitIndex = args.indexOf("--limit");
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : Infinity;

const CONCURRENCY = 5;
const FAILED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BIDDABLE = ["OPEN", "CLOSING_SOON", "UPCOMING"];

const apiKey = process.env.GOOGLE_MAPS_GEOCODE_API_KEY;
if (!apiKey && !dry) {
  console.error("GOOGLE_MAPS_GEOCODE_API_KEY is not configured.");
  process.exit(1);
}

interface KeyDescriptor {
  key: string;
  kind: "postal" | "city";
  country: string;
  postal?: string;
  city?: string;
}

function deriveKey(address: {
  countryCode?: string | null;
  postalCode?: string | null;
  city?: string | null;
}): KeyDescriptor | null {
  const country = address.countryCode?.trim().toUpperCase();
  if (!country) return null;
  const postal = address.postalCode?.trim();
  if (postal) return { key: `${country}:${postal}`, kind: "postal", country, postal };
  const city = address.city?.trim();
  if (city) {
    return { key: `${country}:city:${city.toLowerCase()}`, kind: "city", country, city };
  }
  return null;
}

/** Same request shape as lib/tenders/geocode-cache.ts. */
async function geocode(descriptor: KeyDescriptor): Promise<[number, number] | null> {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  if (descriptor.kind === "postal") {
    url.searchParams.set(
      "components",
      `country:${descriptor.country}|postal_code:${descriptor.postal}`,
    );
  } else {
    url.searchParams.set("address", descriptor.city ?? "");
    url.searchParams.set("components", `country:${descriptor.country}`);
  }
  url.searchParams.set("key", apiKey as string);

  try {
    const response = await fetch(url);
    const data = (await response.json()) as {
      status?: string;
      results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }>;
    };
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
    // network error → soft failure
  }
  return null;
}

const db = await getIngestionDb();
const tenders = db.collection("tenders");
const geoCache = db.collection("geo_cache");

try {
  const scope: Record<string, unknown> = {
    "enrichment.geocoding.status": "PENDING",
  };
  if (!all) scope.status = { $in: BIDDABLE };

  // 1. Mark address-less tenders SKIPPED — nothing will ever geocode them.
  const skippable = {
    ...scope,
    $nor: [
      { "buyer.address.countryCode": { $ne: null }, "buyer.address.postalCode": { $ne: null } },
      { "buyer.address.countryCode": { $ne: null }, "buyer.address.city": { $ne: null } },
    ],
  };
  if (!dry) {
    const skipped = await tenders.updateMany(skippable, {
      $set: {
        "enrichment.geocoding": { status: "SKIPPED", updatedAt: new Date() },
        updatedAt: new Date(),
      },
    });
    console.log(`[geocode] marked ${skipped.modifiedCount} address-less tenders SKIPPED`);
  }

  // 2. Group remaining pending tenders by geo key.
  const cursor = tenders.find(scope, {
    projection: { "buyer.address": 1 },
  });
  const keyToDescriptor = new Map<string, KeyDescriptor>();
  const keyToTenderIds = new Map<string, unknown[]>();
  for await (const tender of cursor) {
    const address = (tender as { buyer?: { address?: Record<string, string | null> } })
      .buyer?.address;
    if (!address) continue;
    const descriptor = deriveKey(address);
    if (!descriptor) continue;
    keyToDescriptor.set(descriptor.key, descriptor);
    const ids = keyToTenderIds.get(descriptor.key) ?? [];
    ids.push(tender._id);
    keyToTenderIds.set(descriptor.key, ids);
  }

  // 3. Split into cached vs to-geocode.
  const keys = [...keyToDescriptor.keys()];
  const cachedDocs = await geoCache
    .find({ _id: { $in: keys } as never })
    .toArray();
  const cacheByKey = new Map(cachedDocs.map((doc) => [String(doc._id), doc]));
  const fromCache: string[] = [];
  const toGeocode: string[] = [];
  for (const key of keys) {
    const doc = cacheByKey.get(key);
    if (doc?.status === "DONE" && doc.location) fromCache.push(key);
    else if (doc?.status === "FAILED") continue; // failure TTL still active
    else toGeocode.push(key);
  }

  const tenderCount = [...keyToTenderIds.values()].reduce((sum, ids) => sum + ids.length, 0);
  console.log(
    `[geocode] scope=${all ? "all" : "biddable"} tenders=${tenderCount} uniqueKeys=${keys.length} cached=${fromCache.length} toGeocode=${toGeocode.length}`,
  );
  console.log(
    `[geocode] estimated new Google calls: ${Math.min(toGeocode.length, limit)} (~$${((Math.min(toGeocode.length, limit) * 5) / 1000).toFixed(2)})`,
  );
  if (dry) process.exit(0);

  // 4. Geocode misses with bounded concurrency; write cache + tenders.
  const capped = toGeocode.slice(0, limit === Infinity ? toGeocode.length : limit);
  let done = 0;
  let failed = 0;
  let processed = 0;

  async function applyKey(key: string, coordinates: [number, number]): Promise<void> {
    const ids = keyToTenderIds.get(key) ?? [];
    if (ids.length === 0) return;
    const point: GeoPoint = { type: "Point", coordinates };
    await tenders.updateMany(
      { _id: { $in: ids } as never },
      {
        $set: {
          "buyer.location": point,
          "enrichment.geocoding": { status: "DONE", updatedAt: new Date() },
          updatedAt: new Date(),
        },
      },
    );
  }

  // Apply already-cached keys first (free).
  for (const key of fromCache) {
    const doc = cacheByKey.get(key)!;
    await applyKey(key, (doc.location as GeoPoint).coordinates);
  }
  console.log(`[geocode] applied ${fromCache.length} cached keys`);

  let cursorIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, capped.length) }, async () => {
      while (cursorIndex < capped.length) {
        const key = capped[cursorIndex++];
        const descriptor = keyToDescriptor.get(key)!;
        const coords = await geocode(descriptor);
        const now = new Date();
        if (coords) {
          done += 1;
          await geoCache.updateOne(
            { _id: key as never },
            {
              $set: {
                countryCode: descriptor.country,
                postalCode: descriptor.postal,
                city: descriptor.city,
                location: { type: "Point", coordinates: coords },
                source: "google",
                status: "DONE",
                updatedAt: now,
              },
              $setOnInsert: { createdAt: now, hitCount: 0 },
            },
            { upsert: true },
          );
          await applyKey(key, coords);
        } else {
          failed += 1;
          await geoCache.updateOne(
            { _id: key as never },
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
        processed += 1;
        if (processed % 200 === 0) {
          console.log(`[geocode] ${processed}/${capped.length} keys (ok=${done} failed=${failed})`);
        }
      }
    }),
  );

  const remaining = await tenders.countDocuments({
    "enrichment.geocoding.status": "PENDING",
    ...(all ? {} : { status: { $in: BIDDABLE } }),
  });
  console.log(
    `[geocode] done: keys ok=${done} failed=${failed}; pending remaining in scope=${remaining}`,
  );
} finally {
  await closeIngestionClient();
}
