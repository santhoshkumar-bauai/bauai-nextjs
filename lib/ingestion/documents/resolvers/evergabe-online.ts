import * as cheerio from "cheerio";

import { logger } from "../../observability/logger.ts";
import type {
  DocumentResolver,
  ResolveContext,
  ResolveOutcome,
  ResolvedFile,
} from "../types.ts";
import { hostMatcher, looksLoginGated } from "./shared.ts";

const log = logger.child("documents.resolver.evergabe-online");

/**
 * e-Vergabe (Bund) — `evergabe-online.de`, the German federal procurement platform.
 *
 * Two traits make a dedicated resolver necessary, both verified 2026-08-05:
 *
 *  1. A cookie handshake. The first request redirects to `?…&cookieCheck` and returns
 *     **HTTP 400** unless the session cookie comes back, which `documents/http.ts`
 *     handles for every portal.
 *  2. Apache Wicket callback links. Document URLs look like
 *     `./tenderdocuments.html?0--documentsTableContainer-…-downloadLink&id=…` — no file
 *     extension and indistinguishable from a page by shape alone. A generic pass over
 *     this page instead collects the portal's own client-software installers
 *     (eVergabeApp, Signatur-Client, OBA), which is exactly the wrong answer.
 *
 * The page offers `zipDownloadButton`, one archive containing every document, so that
 * is preferred over 28 separate Wicket requests. Real file names live in the `title`
 * attribute of each row's anchor, since the callback URL carries none.
 */
const ZIP_BUTTON = /zipDownloadButton/i;
const DOWNLOAD_LINK = /-downloadLink(\b|&|$)/i;
/** Wicket ids are generated and unstable; the panel id and cell class are not. */
const DOCUMENTS_CONTAINER = "#collapseDocumentsDataList";

export const evergabeOnlineResolver: DocumentResolver = {
  platform: "evergabe-online",

  matches: hostMatcher("evergabe-online.de"),

  async resolve({ url, http, signal }: ResolveContext): Promise<ResolveOutcome> {
    // Notices link to either the overview or the document list; only the latter has
    // the table, and the ids are the same on both.
    const target = url
      .toString()
      .replace(/\/tenderdetails\.html/i, "/tenderdocuments.html");

    const page = await http.html(target, signal);
    const $ = cheerio.load(page.body);

    const absolute = (href: string): string | null => {
      try {
        return new URL(href, page.finalUrl).toString();
      } catch {
        return null;
      }
    };

    const zipHref = $("a[href]")
      .toArray()
      .map((element) => $(element).attr("href") ?? "")
      .find((href) => ZIP_BUTTON.test(href));

    if (zipHref) {
      const zipUrl = absolute(zipHref);
      if (zipUrl) {
        log.debug("evergabe-online zip archive found", { url: zipUrl });
        return {
          files: [
            {
              url: zipUrl,
              // The response's Content-Disposition supplies the real archive name.
              fileName: null,
              label: "Alle Vergabeunterlagen (ZIP)",
              referer: page.finalUrl,
            },
          ],
        };
      }
    }

    const files: ResolvedFile[] = [];
    const seen = new Set<string>();

    $(`${DOCUMENTS_CONTAINER} td.filename a[href], ${DOCUMENTS_CONTAINER} a[href]`).each(
      (_, element) => {
        const href = $(element).attr("href");
        if (!href || !DOWNLOAD_LINK.test(href)) return;

        const resolved = absolute(href);
        if (!resolved || seen.has(resolved)) return;
        seen.add(resolved);

        const title = $(element).attr("title")?.trim();
        files.push({
          url: resolved,
          fileName: title || null,
          label: title || $(element).text().replace(/\s+/g, " ").trim() || null,
          referer: page.finalUrl,
        });
      },
    );

    if (files.length) return { files };

    if (looksLoginGated(page.body, 0)) return { skip: "LOGIN_REQUIRED" };
    return { skip: "NO_FILES_FOUND" };
  },
};
