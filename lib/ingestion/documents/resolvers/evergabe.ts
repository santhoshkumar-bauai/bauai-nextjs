import * as cheerio from "cheerio";

import { logger } from "../../observability/logger.ts";
import type {
  DocumentResolver,
  ResolveContext,
  ResolveOutcome,
  ResolvedFile,
} from "../types.ts";
import { hostMatcher, looksLoginGated } from "./shared.ts";

const log = logger.child("documents.resolver.evergabe");

/**
 * evergabe.de — the private platform of evergabe.de GmbH (Leipzig). Not to be
 * confused with `evergabe-online.de`, the federal platform, which has its own
 * resolver.
 *
 * Notices link to the tender detail page
 * (`/auftraege/suche-ueber-vergabestellen/<buyer>/<id>`), which only offers
 * `/unterlagen/<id>/zustellweg-auswaehlen` — a "choose delivery route" funnel
 * pushing registration. The anonymous file table lives one step aside at
 * `/unterlagen/<id>`: one row per document with version, date, file name and
 * an extension-less `/unterlagen/<setId>/download/<fileId>` link that serves
 * the file with a proper Content-Disposition and no login. Notice bodies also
 * carry a token form (`/unterlagen/<nnn>-Tender-<hex>-<hex>`), which redirects
 * into the funnel; its final URL is where the numeric id shows up.
 * All verified 2026-08-11 on procedure 3430388.
 */

const DOWNLOAD_HREF = /\/unterlagen\/\d+\/download\/\d+/;

/** The numeric award-procedure id, from whichever URL form we were given. */
function procedureId(url: string): string | null {
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();
  return (
    path.match(/\/unterlagen\/(\d+)(?:\/|$)/)?.[1] ??
    path.match(/\/(\d+)\/?$/)?.[1] ??
    null
  );
}

function harvest(body: string, baseUrl: string): ResolvedFile[] {
  const $ = cheerio.load(body);
  const files: ResolvedFile[] = [];
  const seen = new Set<string>();

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href") ?? "";
    if (!DOWNLOAD_HREF.test(href)) return;

    let absolute: string;
    try {
      absolute = new URL(href, baseUrl).toString();
    } catch {
      return;
    }
    if (seen.has(absolute)) return;
    seen.add(absolute);

    // The link cell holds only "Datei herunterladen"; the name is two cells
    // to the left (Version | Datum | Dateiname | link). Content-Disposition
    // would supply a name too, but this one is the buyer's own spelling.
    const fileName =
      $(element).closest("tr").find("td").eq(2).text().trim() || null;

    files.push({ url: absolute, fileName, label: fileName, referer: baseUrl });
  });

  return files;
}

export const evergabeResolver: DocumentResolver = {
  platform: "evergabe",

  matches: hostMatcher("evergabe.de"),

  async resolve({ url, http, signal }: ResolveContext): Promise<ResolveOutcome> {
    // Jump straight to the anonymous file table when the id is in the URL.
    const id = procedureId(url.toString());
    let page = await http.html(
      id ? `${url.origin}/unterlagen/${id}` : url.toString(),
      signal,
    );
    let files = harvest(page.body, page.finalUrl);

    // Token-form URLs redirect into the registration funnel; the final URL is
    // the first place the numeric id appears, so retry the table from there.
    if (!files.length && !id) {
      const redirectedId = procedureId(page.finalUrl);
      if (redirectedId) {
        page = await http.html(`${url.origin}/unterlagen/${redirectedId}`, signal);
        files = harvest(page.body, page.finalUrl);
      }
    }

    if (files.length) {
      log.debug("evergabe.de file table resolved", {
        url: page.finalUrl,
        files: files.length,
      });
      return { files };
    }

    if (looksLoginGated(page.body, 0)) return { skip: "LOGIN_REQUIRED" };
    return { skip: "NO_FILES_FOUND" };
  },
};
