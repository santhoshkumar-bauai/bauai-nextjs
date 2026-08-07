import * as cheerio from "cheerio";

import { logger } from "../../observability/logger.ts";
import type {
  DocumentResolver,
  ResolveContext,
  ResolveOutcome,
  ResolvedFile,
} from "../types.ts";
import { looksLoginGated } from "./shared.ts";

const log = logger.child("documents.resolver.rib-meinauftrag");

/**
 * RIB "meinauftrag" — `meinauftrag.rib.de`, the public bidder view for the RIB iTWO /
 * e-Vergabe platforms (used by many Bavarian and municipal buyers).
 *
 * Verified 2026-08-07. The notice URL (`/public/DetailsByPlatformIdAndTenderId/…`)
 * is a single-page app: a static fetch returns only the shell, so it must be rendered.
 * Once rendered it redirects to `/public/publications/<id>` and lists each document as
 * a link on the *underlying* platform, e.g.
 *
 *   https://my.vergabe.bayern.de/remote/download.php?k=<hash>
 *
 * which streams the file directly (verified `application/pdf`). The download host
 * varies per buyer platform, so matching is on the `/remote/download.php` signature
 * rather than a host. This deliberately skips the page's own
 * `rib-software.com/...nutzungsbedingungen.pdf` terms link and third-party chrome.
 */
const DOWNLOAD_SIGNATURE = 'a[href*="/remote/download.php"]';

export const ribMeinauftragResolver: DocumentResolver = {
  platform: "rib-meinauftrag",

  matches: (url) => url.host === "www.meinauftrag.rib.de" || url.host === "meinauftrag.rib.de",

  async resolve({ url, http, signal }: ResolveContext): Promise<ResolveOutcome> {
    if (!http.render) {
      return { skip: "NO_FILES_FOUND", detail: "headless browser required" };
    }

    const page = await http.render(url.toString(), { waitUntil: "networkidle", signal });
    const $ = cheerio.load(page.body);

    const files: ResolvedFile[] = [];
    const seen = new Set<string>();

    $(DOWNLOAD_SIGNATURE).each((_, element) => {
      const href = $(element).attr("href");
      if (!href) return;
      let absolute: string;
      try {
        absolute = new URL(href, page.finalUrl).toString();
      } catch {
        return;
      }
      if (seen.has(absolute)) return;
      seen.add(absolute);

      const label = $(element).text().replace(/\s+/g, " ").trim();
      files.push({
        url: absolute,
        // The download response's Content-Disposition supplies the real file name.
        fileName: null,
        label: label || null,
        referer: page.finalUrl,
      });
    });

    if (files.length) {
      log.debug("rib documents found", { count: files.length });
      return { files };
    }

    if (looksLoginGated(page.body, 0)) return { skip: "LOGIN_REQUIRED" };
    return { skip: "NO_FILES_FOUND" };
  },
};
