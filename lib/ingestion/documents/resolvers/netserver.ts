import * as cheerio from "cheerio";

import { logger } from "../../observability/logger.ts";
import type {
  DocumentResolver,
  ResolveContext,
  ResolveOutcome,
} from "../types.ts";
import { looksLoginGated, stripSessionParams } from "./shared.ts";

const log = logger.child("documents.resolver.netserver");

/**
 * Administration Intelligence "AI Vergabeplattform" — the `/NetServer/` servlet family.
 *
 * One resolver for a large family of German portals, verified 2026-08-07 across
 * `tender24.de`, `vergabe.vmstart.de`, `sachsen-vergabe.de`, `had.de`,
 * `vergabe.landbw.de`, `vergabe.hessen.de` and `vergabe.fraunhofer.de`. All run the
 * same software; the tell is the `/NetServer/` path segment with one of two servlets:
 *
 *   PublicationControllerServlet?function=Detail&TWOID=…   (the public notice page)
 *   TenderingProcedureDetails?function=_Details&TenderOID=… (the procedure page)
 *
 * Matching is on the `/NetServer/` path signature rather than a host list, so a portal
 * we have not catalogued yet is handled without a code change.
 *
 * Documents are published as one bundle behind a single action:
 *
 *   TenderingProcedureDetails?function=_DownloadTenderDocuments&documentOID=<SpecificationVersion-…>
 *
 * which streams `application/zip` (14–19 MB seen in practice); the runner unpacks it.
 * The link is present only when the pack is **public** — the state portals that require
 * a bidder login simply omit it and show a `LoginControllerServlet` form instead. Keying
 * on this exact action is therefore what separates a public portal from a gated one, and
 * it deliberately ignores the generic "Bieterunterstützung" support PDFs some portals
 * (e.g. Fraunhofer) link in the page chrome, which are not tender documents.
 *
 * A PublicationControllerServlet notice page carries the download link one hop away, on
 * its linked `_Details` page, so that hop is followed once before giving up.
 */
const NETSERVER_PATH = /\/NetServer\//i;
const DOWNLOAD_ACTION = "_DownloadTenderDocuments";
/** The procedure page that actually carries the download action. */
const DETAILS_SELECTOR =
  'a[href*="TenderingProcedureDetails"][href*="function=_Details"]';
const LOGIN_SERVLET = /LoginControllerServlet/i;

export const netserverResolver: DocumentResolver = {
  platform: "netserver",

  matches(url: URL): boolean {
    return NETSERVER_PATH.test(url.pathname);
  },

  async resolve({ url, http, signal }: ResolveContext): Promise<ResolveOutcome> {
    const page = await http.html(url.toString(), signal);

    let download = findDownloadLink(page.body, page.finalUrl);

    // A PublicationControllerServlet notice page links to the procedure page, and the
    // download action lives there. Follow that one hop before concluding there is none.
    if (!download) {
      const detailsUrl = firstMatch(page.body, page.finalUrl, DETAILS_SELECTOR);
      if (detailsUrl) {
        const inner = await http.html(detailsUrl, signal);
        download = findDownloadLink(inner.body, inner.finalUrl);
      }
    }

    if (download) {
      log.debug("netserver document bundle found", { url: download });
      return {
        files: [
          {
            url: download,
            // The response's Content-Disposition supplies the real archive name.
            fileName: null,
            label: "Vergabeunterlagen (ZIP)",
            referer: page.finalUrl,
          },
        ],
      };
    }

    // No public download action. These portals gate the pack behind a bidder login,
    // which is the actionable reason — not an empty or broken page.
    if (LOGIN_SERVLET.test(page.body) || looksLoginGated(page.body, 0)) {
      return { skip: "LOGIN_REQUIRED" };
    }
    return { skip: "NO_FILES_FOUND" };
  },
};

/** The public document-bundle download link on a page, absolute and session-clean. */
function findDownloadLink(html: string, baseUrl: string): string | null {
  return firstMatch(html, baseUrl, `a[href*="${DOWNLOAD_ACTION}"]`);
}

function firstMatch(html: string, baseUrl: string, selector: string): string | null {
  const $ = cheerio.load(html);
  const href = $(selector).first().attr("href");
  if (!href) return null;
  try {
    // cheerio decodes the `&amp;` entities the servlet emits in its query string.
    return stripSessionParams(new URL(href, baseUrl).toString());
  } catch {
    return null;
  }
}
