import type { Db, ObjectId } from "mongodb";

import { searchIndexNames } from "../ai/db/search-indexes.ts";
import { fuseRanks } from "../ai/retrieval/rrf.ts";
import { OPPORTUNITY_CATEGORIES, OPPORTUNITY_STATUSES } from "./relevance.ts";
import type { ProfileTerm } from "./profile-terms.ts";

/**
 * The lexical arm: rank tenders by what the notice actually says.
 *
 * Runs against `sx_tenders`, the full-text index over the notice's own title,
 * description and lot descriptions — the text as published, before anyone
 * classified it. Nothing here reads a CPV code, which is the point: a tender
 * filed with the wrong code, or with no code at all, is found on its words.
 *
 * Returns ids in rank order for the caller to fuse. It deliberately does not
 * score, filter by deadline, or project display fields — `buildRelevancePipeline`
 * owns all of that, and having two places decide what is visible is how the two
 * feeds start disagreeing.
 */

/** How deep the arm reaches. Mirrors the AI matcher's per-facet candidate cap. */
export const TEXT_ARM_DEPTH = 250;

export interface TextArmOptions {
  countries: string[];
  /** NUTS prefixes to prefer — a soft boost, never a filter. */
  nutsCodes?: string[];
  /** Restrict to these NUTS codes outright. Used for the local pass. */
  regionFilter?: string[];
  contractNatures?: string[];
  statuses?: string[];
  limit?: number;
}

export interface TextArmHit {
  tenderId: ObjectId;
  score: number;
}

/**
 * Region enters as a `should` boost rather than a filter.
 *
 * A company's own state is where most of its work is, but a strong capability
 * match one state over is a real opportunity and the classic feed already
 * scores geography separately. Filtering here would apply that penalty twice
 * and hide the tenders the arm exists to surface.
 */
const REGION_BOOST = 6;

/**
 * Every text field the arm reads, under both analyzers.
 *
 * Lot text is in here because on a lot-split notice — the dominant shape in
 * German construction procurement — the trade is named in the lot and nowhere
 * else. "Neubau FFW Schwarzholz" says nothing; "Los 4 Elektroinstallation"
 * says everything.
 */
const TEXT_PATHS = [
  "title",
  { value: "title", multi: "std" },
  "description",
  { value: "description", multi: "std" },
  "lots.title",
  { value: "lots.title", multi: "std" },
  "lots.description",
  { value: "lots.description", multi: "std" },
];

/**
 * One clause per term — phrase for anything multi-word, plain text otherwise.
 *
 * The distinction is not cosmetic. `text` ORs its tokens, so a multi-word term
 * scores a document that contains only its filler: with `text`, the term
 * "Technische Gebäudeausrüstung" pulled in every notice containing "technisch"
 * anywhere. `phrase` requires the words together, and `slop` leaves room for
 * the declensions and inserted articles that German puts between them.
 */
function termClause(term: ProfileTerm): Record<string, unknown> {
  const multiWord = term.text.includes(" ");
  if (!multiWord) {
    return {
      text: {
        query: term.text,
        path: TEXT_PATHS,
        score: { boost: { value: term.weight } },
      },
    };
  }
  return {
    phrase: {
      query: term.text,
      path: TEXT_PATHS,
      slop: 2,
      score: { boost: { value: term.weight } },
    },
  };
}

export function buildTextArmStages(
  terms: ProfileTerm[],
  options: TextArmOptions,
): Record<string, unknown>[] {
  const statuses = options.statuses?.length ? options.statuses : [...OPPORTUNITY_STATUSES];

  // The terms go under `must` as a nested compound, NOT alongside the region
  // boost in one `should`. Flat, the region clause satisfies
  // `minimumShouldMatch` all by itself, and the arm returns every notice in
  // the company's state whether or not a single term matched — which is how a
  // bridge builder's feed ended up holding a winter road-gritting contract, a
  // youth employment programme and a postal services framework, none of which
  // matched any term at all. Nested, at least one real term is required and
  // the region can only ever add score.
  const should: Record<string, unknown>[] = [];
  const nutsCodes = options.nutsCodes ?? [];
  if (nutsCodes.length) {
    // `in`, not `text` — `regions` is mapped as a token field, which the text
    // operator does not analyze against.
    should.push({
      in: {
        path: "regions",
        value: nutsCodes,
        score: { boost: { value: REGION_BOOST } },
      },
    });
  }

  const filter: Record<string, unknown>[] = [
    { equals: { path: "isVisible", value: true } },
    { in: { path: "status", value: statuses } },
    { in: { path: "businessCategory", value: [...OPPORTUNITY_CATEGORIES] } },
  ];
  if (options.countries.length) {
    filter.push({ in: { path: "countries", value: options.countries } });
  }
  if (options.contractNatures?.length) {
    filter.push({ in: { path: "contractNature", value: options.contractNatures } });
  }
  if (options.regionFilter?.length) {
    filter.push({ in: { path: "regions", value: options.regionFilter } });
  }

  return [
    {
      $search: {
        index: searchIndexNames.tenderText,
        compound: {
          filter,
          must: [{ compound: { should: terms.map(termClause), minimumShouldMatch: 1 } }],
          should,
        },
      },
    },
    { $limit: options.limit ?? TEXT_ARM_DEPTH },
    { $project: { _id: 0, tenderId: "$_id", score: { $meta: "searchScore" } } },
  ];
}

export async function runTextArm(
  db: Db,
  terms: ProfileTerm[],
  options: TextArmOptions,
): Promise<TextArmHit[]> {
  if (terms.length === 0) return [];
  return (
    db
      .collection("tenders")
      // Mandatory, exactly as in `lib/ai/match/retrieve.ts`: `$search`
      // rejects the ingestion client's default majority read concern.
      .aggregate<TextArmHit>(buildTextArmStages(terms, options), {
        readConcern: { level: "local" },
      })
      .toArray()
  );
}

/** Weight of the home-region pass when the two passes are fused. */
const W_LOCAL_PASS = 1.3;
const W_NATIONAL_PASS = 1;

/**
 * Rank the corpus against the profile, best first, as one list.
 *
 * Two passes — the company's own NUTS regions, then the country — fused by
 * rank. This is structural rather than a scoring boost on purpose: BM25 totals
 * here run from 50 to 150 and vary with term rarity, so a `should` boost large
 * enough to matter for one profile swamps the text signal for the next. Two
 * passes guarantee the home region is represented no matter how the scores
 * happen to fall, and RRF needs no calibration between them.
 *
 * Out-of-region hits are kept rather than filtered: the composite score already
 * charges them for distance, and for a specialist trade the nearest real
 * opportunity is regularly one state over.
 */
export async function rankTendersByProfileText(
  db: Db,
  terms: ProfileTerm[],
  options: TextArmOptions,
): Promise<ObjectId[]> {
  if (terms.length === 0) return [];

  const local = options.nutsCodes?.length
    ? { ...options, regionFilter: options.nutsCodes }
    : null;

  const [localHits, nationalHits] = await Promise.all([
    local ? runTextArm(db, terms, local) : Promise.resolve<TextArmHit[]>([]),
    runTextArm(db, terms, options),
  ]);

  const fused = fuseRanks([
    { ids: localHits.map((hit) => hit.tenderId.toHexString()), weight: W_LOCAL_PASS },
    {
      ids: nationalHits.map((hit) => hit.tenderId.toHexString()),
      weight: W_NATIONAL_PASS,
    },
  ]);

  const byId = new Map(
    [...localHits, ...nationalHits].map((hit) => [hit.tenderId.toHexString(), hit.tenderId]),
  );
  return fused.flatMap((entry) => {
    const id = byId.get(entry.id);
    return id ? [id] : [];
  });
}
