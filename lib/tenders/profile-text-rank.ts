import type { ObjectId } from "mongodb";

import { isSearchUnavailable } from "@/lib/ai/match/retrieve";
import { mongoDatabase } from "@/lib/db/mongodb";
import type { NutsResolution } from "@/lib/tenders/nuts";
import { buildProfileTerms, hasUsableTerms } from "@/lib/tenders/profile-terms";
import { rankTendersByProfileText } from "@/lib/tenders/text-arm";

/**
 * The feed's entry point to the notice-text arm: company in, ranked tender ids
 * out, never throwing.
 *
 * Best-effort is the contract. The tenders page is the product's front door and
 * it worked before this arm existed, so a deployment without Atlas Search, a
 * profile with nothing in it yet, or a search index still building must all
 * degrade to the CPV-and-geography feed rather than surface an error.
 */

export interface RankProfileTextInput {
  company: {
    services?: string[] | null;
    trade?: string[] | null;
    specializations?: string[] | null;
    businessDomain?: string | null;
    cpvCodes?: string[] | null;
  };
  countries: string[];
  nuts: NutsResolution;
  contractNatures?: string[];
  statuses?: string[];
}

export async function rankProfileText(
  input: RankProfileTextInput,
): Promise<ObjectId[]> {
  const terms = await buildProfileTerms(input.company).catch(() => []);
  if (!hasUsableTerms(terms)) return [];

  // NUTS1 and NUTS2 only. NUTS3 is a district, and the corpus mostly codes
  // tenders at NUTS2 ("DEE0") — filtering the local pass on a district would
  // return nothing and quietly waste the pass.
  const nutsCodes = [input.nuts.nuts2, input.nuts.nuts1].filter(
    (code): code is string => Boolean(code),
  );

  try {
    return await rankTendersByProfileText(mongoDatabase, terms, {
      countries: input.countries,
      nutsCodes,
      contractNatures: input.contractNatures?.length
        ? input.contractNatures
        : undefined,
      statuses: input.statuses?.length ? input.statuses : undefined,
    });
  } catch (error) {
    if (isSearchUnavailable(error)) return [];
    throw error;
  }
}
