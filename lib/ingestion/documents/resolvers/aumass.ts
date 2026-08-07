import * as cheerio from "cheerio";

import { logger } from "../../observability/logger.ts";
import type {
  DocumentResolver,
  ResolveContext,
  ResolveOutcome,
} from "../types.ts";
import { hostMatcher, looksLoginGated, stripSessionParams } from "./shared.ts";

const log = logger.child("documents.resolver.aumass");

/**
 * AUMASS `plattform.aumass.de` — the "Vergabeplattform" run by aumass GmbH.
 *
 * Verified 2026-08-07. A notice URL (`/Veroeffentlichung/<id>`) redirects to the
 * publication preview, which offers the complete document set two ways:
 *
 *  - a "DOWNLOAD" button that is `javascript:void(0)` and needs a registered account;
 *  - a public **"Ohne Registrierung herunterladen"** link inside `.freierDownloadLinkArea`:
 *      /Document/GetDocument?doctype=allfiles&aumassid=<AV…>
 *    which streams the whole set as one archive (served `application/octet-stream`, so
 *    the runner recognises it by the ZIP header and unpacks the members).
 *
 * Keying on the public `doctype=allfiles` link takes the no-registration path and
 * deliberately ignores the page's `/PDFConverter/ConvertToPDF` "save as PDF" self-link
 * and the operator's own `www.aumass.de/Downloads/*` help PDFs, neither of which is a
 * tender document. When only the registration-gated button is present the pack is not
 * public, which is the actionable reason to record.
 */
const GET_DOCUMENT = "/Document/GetDocument";
const ALL_FILES = /doctype=allfiles/i;

export const aumassResolver: DocumentResolver = {
  platform: "aumass",

  matches: hostMatcher("plattform.aumass.de"),

  async resolve({ url, http, signal }: ResolveContext): Promise<ResolveOutcome> {
    const page = await http.html(url.toString(), signal);
    const $ = cheerio.load(page.body);

    const bundleHref = $(`a[href*="${GET_DOCUMENT}"]`)
      .toArray()
      .map((element) => $(element).attr("href") ?? "")
      .find((href) => ALL_FILES.test(href));

    if (bundleHref) {
      try {
        const bundleUrl = stripSessionParams(new URL(bundleHref, page.finalUrl).toString());
        log.debug("aumass public document bundle found", { url: bundleUrl });
        return {
          files: [
            {
              url: bundleUrl,
              // Content-Disposition on the response carries the real archive name.
              fileName: null,
              label: "Alle Vergabeunterlagen (ZIP)",
              referer: page.finalUrl,
            },
          ],
        };
      } catch {
        /* fall through to the skip reasons below */
      }
    }

    // No public bundle: the documents sit behind the registration-gated button.
    if (looksLoginGated(page.body, 0)) return { skip: "LOGIN_REQUIRED" };
    return { skip: "NO_FILES_FOUND" };
  },
};
