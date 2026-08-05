import { logger } from "../../observability/logger.ts";
import type {
  DocumentResolver,
  ResolveContext,
  ResolveOutcome,
  ResolvedFile,
} from "../types.ts";
import {
  fileNameFromUrl,
  harvestFileLinks,
  isDefinitelyFileUrl,
  looksLoginGated,
  stripSessionParams,
} from "./shared.ts";

const log = logger.child("documents.resolver.cosinex");

/**
 * cosinex "Vergabemarktplatz" / DTVP platform.
 *
 * One resolver for a whole family of portals. Verified 2026-08-05 that
 * `dtvp.de/Satellite/notice/<id>/documents` and
 * `vergabemarktplatz.brandenburg.de/VMPSatellite/notice/<id>/documents` are the same
 * software, and the German state marketplaces (`vergabe.niedersachsen.de`,
 * `sachsen-vergabe.de`, `vergabe-westfalen.de`, `vergabe.landbw.de`,
 * `vmp-rheinland.de`, `vergabe.metropoleruhr.de`) run it too — together the largest
 * share of German document links.
 *
 * Matching is on the `…Satellite/` path signature rather than a host list, so a state
 * portal we have not seen yet is handled without a code change.
 *
 * These portals publish the complete tender pack as one public ZIP:
 *
 *   /<x>Satellite/public/company/project/<id>/de/documents/archive/Vergabeunterlagen_<id>.zip
 *
 * labelled "Alle Dokumente als ZIP-Datei herunterladen". Taking the archive is one
 * request instead of many, and the runner unpacks its members individually.
 */
const SATELLITE_PATH = /\/[A-Za-z]*Satellite\//;
const ARCHIVE_PATH = /\/documents\/archive\//i;
/** `/notice/<id>` with nothing after it — the overview page, not the document list. */
const BARE_NOTICE_PATH = /\/notice\/[^/]+\/?$/i;

export const cosinexResolver: DocumentResolver = {
  platform: "cosinex",

  matches(url: URL): boolean {
    return SATELLITE_PATH.test(url.pathname);
  },

  async resolve({ url, http, signal }: ResolveContext): Promise<ResolveOutcome> {
    // Notices link to either `/notice/<id>` or `/notice/<id>/documents`. The overview
    // page prompts for a login and lists no files, while the documents page is public
    // — so a bare notice URL is redirected to its document list rather than being
    // written off as login-gated.
    const target = BARE_NOTICE_PATH.test(url.pathname)
      ? new URL(`${url.pathname.replace(/\/$/, "")}/documents${url.search}`, url).toString()
      : url.toString();

    const page = await http.html(target, signal);

    const links = harvestFileLinks(page.body, page.finalUrl, {
      // The page's own `./documents` self-link matches the generic download heuristic,
      // so acceptance here is explicit: the ZIP archive, or a real document extension.
      accept: (href) => ARCHIVE_PATH.test(href) || isDefinitelyFileUrl(href),
    });

    const cleaned = links.map(normalize);
    const archive = cleaned.find((file) => ARCHIVE_PATH.test(file.url));

    if (archive) {
      log.debug("cosinex archive found", { url: archive.url });
      return { files: [archive] };
    }

    const individual = cleaned.filter((file) => isDefinitelyFileUrl(file.url));
    if (individual.length) return { files: individual };

    if (looksLoginGated(page.body, 0)) return { skip: "LOGIN_REQUIRED" };
    return { skip: "NO_FILES_FOUND" };
  },
};

/** Strips the session token so the stored name and content key stay stable. */
function normalize(file: ResolvedFile): ResolvedFile {
  const url = stripSessionParams(file.url);
  return { ...file, url, fileName: fileNameFromUrl(url) ?? file.fileName };
}
