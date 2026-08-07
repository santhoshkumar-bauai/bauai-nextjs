import * as cheerio from "cheerio";

import { logger } from "../../observability/logger.ts";
import type {
  DocumentResolver,
  ResolveContext,
  ResolveOutcome,
} from "../types.ts";
import { hostMatcher, looksLoginGated } from "./shared.ts";

const log = logger.child("documents.resolver.staatsanzeiger");

/**
 * Staatsanzeiger eVergabeplattform — `staatsanzeiger-eservices.de` (SeS-System).
 *
 * Verified 2026-08-07. A notice URL (`/aJs/EFormsBekVuUrl?z_param=<id>`) opens a
 * "how do you want to download?" page with two POST forms:
 *
 *   action="DownlAsAnonym"  → "Anonym als Zip"        (public, no account)
 *   action="DownlAsKunde"   → "Als Kunde im Profil"   (registered customers)
 *
 * POSTing the anonymous form (carrying the `z_param` and the JSESSIONID the first GET
 * set) returns a page that links the finished archive, hosted on the sister domain:
 *
 *   https://www.staatsanzeiger-eservices.eu/<name>.zip
 *
 * which is a public `application/zip` (no session needed for the file itself). The two
 * hops — GET the choice page to open the session, POST the anonymous form to mint the
 * archive link — are why this needs a dedicated resolver rather than the generic pass.
 */
const ANON_FORM = 'form[action*="DownlAsAnonym"]';

export const staatsanzeigerResolver: DocumentResolver = {
  platform: "staatsanzeiger",

  matches: hostMatcher("staatsanzeiger-eservices.de"),

  async resolve({ url, http, signal }: ResolveContext): Promise<ResolveOutcome> {
    // The GET opens the session (JSESSIONID) that the POST below relies on.
    const page = await http.html(url.toString(), signal);
    const $ = cheerio.load(page.body);

    const form = $(ANON_FORM).first();
    const action = form.attr("action");
    const zParam = form.find('input[name="z_param"]').attr("value");

    // No anonymous form means the pack is customers-only.
    if (!action || !zParam) {
      if (looksLoginGated(page.body, 0)) return { skip: "LOGIN_REQUIRED" };
      return { skip: "NO_FILES_FOUND" };
    }
    if (!http.post) return { skip: "NO_FILES_FOUND", detail: "POST fetch unavailable" };

    const actionUrl = new URL(action, page.finalUrl).toString();
    const result = await http.post(actionUrl, { z_param: zParam }, signal);

    const $result = cheerio.load(result.body);
    const zipHref = $result("a[href]")
      .toArray()
      .map((element) => $result(element).attr("href") ?? "")
      .find((href) => /\.zip(\?|#|$)/i.test(href));

    if (!zipHref) {
      if (looksLoginGated(result.body, 0)) return { skip: "LOGIN_REQUIRED" };
      return { skip: "NO_FILES_FOUND" };
    }

    const zipUrl = new URL(zipHref, result.finalUrl).toString();
    log.debug("staatsanzeiger archive minted", { url: zipUrl });
    return {
      files: [
        {
          url: zipUrl,
          fileName: null,
          label: "Vergabeunterlagen (ZIP)",
        },
      ],
    };
  },
};
