/**
 * Company → NUTS resolver.
 *
 * Tenders carry `regions: string[]` NUTS codes (e.g. "DE30") but almost never
 * `buyer.location` coordinates yet, so proximity ranking is done by NUTS-tier
 * overlap rather than geo-distance. The company side, however, has no NUTS code
 * at all — only a free-text `region` ("berlin", "Berlin, Germany") and an
 * optional `regionLocation` / `addressCoordinates` lat/lng.
 *
 * This module bridges that gap with a bundled, offline, zero-cost lookup. The
 * ingested corpus is DE-heavy (~96% DE), so a German table covers the common
 * case; other countries fall back to country-only proximity (CPV + recency then
 * dominate — the feature still works, just coarser). A coordinate-based nearest
 * centroid fallback catches companies whose region text we can't parse.
 *
 * NUTS hierarchy reminder: DE3 (NUTS1, Berlin) ⊃ DE30 (NUTS2) ⊃ DE300 (NUTS3).
 */

export interface NutsResolution {
  /** ISO country code, e.g. "DE". Always present. */
  country: string;
  nuts1?: string;
  nuts2?: string;
  nuts3?: string;
  /** How the resolution was obtained — surfaced to the UI for transparency. */
  source: "nuts-code" | "name" | "coordinates" | "country-only";
}

interface NutsEntry {
  nuts1: string;
  nuts2?: string;
  nuts3?: string;
  /** Approximate city/state centroid, for the coordinate fallback. [lat, lng]. */
  center?: [number, number];
}

/**
 * German major cities → NUTS. Checked before states because a city name is the
 * more specific signal (it resolves NUTS2/NUTS3, not just NUTS1).
 */
const DE_CITIES: Record<string, NutsEntry> = {
  berlin: { nuts1: "DE3", nuts2: "DE30", nuts3: "DE300", center: [52.52, 13.405] },
  hamburg: { nuts1: "DE6", nuts2: "DE60", nuts3: "DE600", center: [53.55, 9.993] },
  muenchen: { nuts1: "DE2", nuts2: "DE21", nuts3: "DE212", center: [48.137, 11.575] },
  munich: { nuts1: "DE2", nuts2: "DE21", nuts3: "DE212", center: [48.137, 11.575] },
  koeln: { nuts1: "DEA", nuts2: "DEA2", nuts3: "DEA23", center: [50.937, 6.96] },
  cologne: { nuts1: "DEA", nuts2: "DEA2", nuts3: "DEA23", center: [50.937, 6.96] },
  frankfurt: { nuts1: "DE7", nuts2: "DE71", nuts3: "DE712", center: [50.11, 8.682] },
  stuttgart: { nuts1: "DE1", nuts2: "DE11", nuts3: "DE111", center: [48.775, 9.182] },
  duesseldorf: { nuts1: "DEA", nuts2: "DEA1", nuts3: "DEA11", center: [51.228, 6.773] },
  dortmund: { nuts1: "DEA", nuts2: "DEA5", nuts3: "DEA52", center: [51.514, 7.466] },
  essen: { nuts1: "DEA", nuts2: "DEA1", nuts3: "DEA13", center: [51.456, 7.012] },
  leipzig: { nuts1: "DED", nuts2: "DED5", nuts3: "DED51", center: [51.34, 12.375] },
  dresden: { nuts1: "DED", nuts2: "DED2", nuts3: "DED21", center: [51.05, 13.737] },
  hannover: { nuts1: "DE9", nuts2: "DE92", nuts3: "DE929", center: [52.376, 9.732] },
  hanover: { nuts1: "DE9", nuts2: "DE92", nuts3: "DE929", center: [52.376, 9.732] },
  nuernberg: { nuts1: "DE2", nuts2: "DE25", nuts3: "DE254", center: [49.452, 11.077] },
  nuremberg: { nuts1: "DE2", nuts2: "DE25", nuts3: "DE254", center: [49.452, 11.077] },
  bremen: { nuts1: "DE5", nuts2: "DE50", nuts3: "DE501", center: [53.079, 8.802] },
  duisburg: { nuts1: "DEA", nuts2: "DEA1", nuts3: "DEA12", center: [51.435, 6.762] },
  bochum: { nuts1: "DEA", nuts2: "DEA5", nuts3: "DEA51", center: [51.482, 7.216] },
  wuppertal: { nuts1: "DEA", nuts2: "DEA1", nuts3: "DEA1A", center: [51.256, 7.15] },
  bielefeld: { nuts1: "DEA", nuts2: "DEA4", nuts3: "DEA41", center: [52.03, 8.532] },
  bonn: { nuts1: "DEA", nuts2: "DEA2", nuts3: "DEA22", center: [50.737, 7.098] },
  muenster: { nuts1: "DEA", nuts2: "DEA3", nuts3: "DEA33", center: [51.96, 7.626] },
  karlsruhe: { nuts1: "DE1", nuts2: "DE12", nuts3: "DE121", center: [49.007, 8.404] },
  mannheim: { nuts1: "DE1", nuts2: "DE12", nuts3: "DE126", center: [49.487, 8.466] },
  augsburg: { nuts1: "DE2", nuts2: "DE27", nuts3: "DE271", center: [48.371, 10.898] },
  wiesbaden: { nuts1: "DE7", nuts2: "DE71", nuts3: "DE714", center: [50.083, 8.24] },
  aachen: { nuts1: "DEA", nuts2: "DEA2", nuts3: "DEA2D", center: [50.776, 6.084] },
};

/**
 * German states (Bundesländer) → NUTS1. City-states also carry NUTS2/NUTS3.
 * Keys are normalized (lowercase, ASCII-folded) and matched as substrings.
 */
const DE_STATES: Record<string, NutsEntry> = {
  "baden-wuerttemberg": { nuts1: "DE1", center: [48.66, 9.35] },
  bayern: { nuts1: "DE2", center: [48.79, 11.5] },
  bavaria: { nuts1: "DE2", center: [48.79, 11.5] },
  brandenburg: { nuts1: "DE4", nuts2: "DE40", center: [52.13, 13.2] },
  hessen: { nuts1: "DE7", center: [50.65, 9.16] },
  hesse: { nuts1: "DE7", center: [50.65, 9.16] },
  "mecklenburg-vorpommern": { nuts1: "DE8", nuts2: "DE80", center: [53.75, 12.57] },
  niedersachsen: { nuts1: "DE9", center: [52.64, 9.85] },
  "lower saxony": { nuts1: "DE9", center: [52.64, 9.85] },
  "nordrhein-westfalen": { nuts1: "DEA", center: [51.43, 7.66] },
  "north rhine-westphalia": { nuts1: "DEA", center: [51.43, 7.66] },
  nrw: { nuts1: "DEA", center: [51.43, 7.66] },
  "rheinland-pfalz": { nuts1: "DEB", center: [49.91, 7.45] },
  "rhineland-palatinate": { nuts1: "DEB", center: [49.91, 7.45] },
  saarland: { nuts1: "DEC", nuts2: "DEC0", center: [49.38, 6.96] },
  sachsen: { nuts1: "DED", center: [51.05, 13.45] },
  saxony: { nuts1: "DED", center: [51.05, 13.45] },
  "sachsen-anhalt": { nuts1: "DEE", nuts2: "DEE0", center: [51.95, 11.69] },
  "saxony-anhalt": { nuts1: "DEE", nuts2: "DEE0", center: [51.95, 11.69] },
  "schleswig-holstein": { nuts1: "DEF", nuts2: "DEF0", center: [54.22, 9.7] },
  thueringen: { nuts1: "DEG", nuts2: "DEG0", center: [50.9, 11.03] },
  thuringia: { nuts1: "DEG", nuts2: "DEG0", center: [50.9, 11.03] },
};

/** Lowercase, fold German umlauts/ß to ASCII, collapse whitespace. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/\s+/g, " ")
    .trim();
}

function nearestCenter(
  lat: number,
  lng: number,
): NutsEntry | undefined {
  let best: NutsEntry | undefined;
  let bestDist = Infinity;
  for (const entry of [...Object.values(DE_CITIES), ...Object.values(DE_STATES)]) {
    if (!entry.center) continue;
    const [clat, clng] = entry.center;
    // Squared euclidean on lat/lng is fine for "nearest of a small fixed set".
    const dist = (clat - lat) ** 2 + (clng - lng) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = entry;
    }
  }
  // Guard against a company pin far outside Germany matching a DE centroid.
  return bestDist <= 25 ? best : undefined;
}

type CompanyGeoInput = {
  region?: string | null;
  regionLocation?: { latitude?: number; longitude?: number } | null;
  addressCoordinates?: { lat?: number; lng?: number } | null;
};

/** Project a lookup entry into a resolution, dropping the internal centroid. */
function fromEntry(entry: NutsEntry, source: NutsResolution["source"]): NutsResolution {
  return {
    country: "DE",
    nuts1: entry.nuts1,
    nuts2: entry.nuts2,
    nuts3: entry.nuts3,
    source,
  };
}

/**
 * Resolves a company's geography to NUTS tiers. Priority: an already-NUTS
 * region string → name lookup → nearest-centroid from stored coordinates →
 * country-only. Never makes a network call.
 */
export function resolveCompanyNuts(company: CompanyGeoInput): NutsResolution {
  const region = company.region?.trim();

  // 1. Region is already a NUTS code (e.g. re-onboarded with a code).
  if (region && /^DE[0-9A-Z]{1,3}$/i.test(region)) {
    const code = region.toUpperCase();
    return {
      country: "DE",
      nuts1: code.slice(0, 3),
      nuts2: code.length >= 4 ? code.slice(0, 4) : undefined,
      nuts3: code.length >= 5 ? code.slice(0, 5) : undefined,
      source: "nuts-code",
    };
  }

  // 2. Name lookup — cities first (more specific), then states.
  if (region) {
    const norm = normalize(region);
    for (const [key, entry] of Object.entries(DE_CITIES)) {
      if (norm.includes(key)) return fromEntry(entry, "name");
    }
    for (const [key, entry] of Object.entries(DE_STATES)) {
      if (norm.includes(key)) return fromEntry(entry, "name");
    }
  }

  // 3. Coordinate fallback — nearest known German centroid.
  const lat = company.regionLocation?.latitude ?? company.addressCoordinates?.lat;
  const lng = company.regionLocation?.longitude ?? company.addressCoordinates?.lng;
  if (typeof lat === "number" && typeof lng === "number") {
    const entry = nearestCenter(lat, lng);
    if (entry) return fromEntry(entry, "coordinates");
  }

  // 4. Nothing resolved — country baseline. Default to DE (dominant corpus).
  return { country: "DE", source: "country-only" };
}

/**
 * The NUTS codes to feed a `regions: { $in: [...] }` recall filter — the most
 * specific tiers a tender's `regions[]` could contain to be "near" the company.
 */
export function companyNutsCodes(res: NutsResolution): string[] {
  return [res.nuts3, res.nuts2, res.nuts1].filter(Boolean) as string[];
}
