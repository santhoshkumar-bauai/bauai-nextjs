import * as cheerio from "cheerio";

import type { ResolvedFile } from "../types.ts";

/**
 * Helpers shared by the platform resolvers.
 *
 * Portals differ in markup but agree on the shape of the problem: find anchors that
 * lead to files, label them, and tell a login wall apart from an empty page.
 */

/** Extensions that indicate a document rather than another page. */
const FILE_EXTENSIONS =
  /\.(pdf|zip|7z|rar|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv|dwg|dxf|ifc|gaeb|x8[0-9]|p9[0-9]|d8[0-9]|jpe?g|png|tiff?)(\?|#|$)/i;

/**
 * Extensions that are pages even when the path talks about documents.
 * `tenderdocuments.html?id=880069` is a listing page, not a file — without this it
 * matches the download hints below and the page gets stored as if it were a document.
 */
const PAGE_EXTENSIONS = /\.(html?|aspx?|jspx?|php|do|action)(\?|#|$)/i;

/** Words portals use on download endpoints that carry no file extension. */
const DOWNLOAD_HINTS =
  /(download|datei|dokument|document|attachment|anlage|getfile|blob|export)/i;

/** A real document extension: safe to treat as a file without asking the server. */
export function isDefinitelyFileUrl(url: string): boolean {
  return FILE_EXTENSIONS.test(url) && !PAGE_EXTENSIONS.test(url);
}

/**
 * Might be a download endpoint, but must be confirmed with a request. Paths like
 * `/notice/<id>/documents` look like downloads and are pages.
 */
export function isMaybeDownloadUrl(url: string): boolean {
  if (isDefinitelyFileUrl(url)) return true;
  if (PAGE_EXTENSIONS.test(url)) return false;
  try {
    const parsed = new URL(url);
    return DOWNLOAD_HINTS.test(parsed.pathname) || DOWNLOAD_HINTS.test(parsed.search);
  } catch {
    return false;
  }
}

/** Kept for callers that only need "could this be a file at all". */
export function looksLikeFileUrl(url: string): boolean {
  return isMaybeDownloadUrl(url);
}

/** Same registrable-ish host, so a page's own files are kept and third parties are not. */
export function isSameSite(candidate: string, pageUrl: string): boolean {
  try {
    const a = new URL(candidate).host.toLowerCase();
    const b = new URL(pageUrl).host.toLowerCase();
    if (a === b) return true;
    const tail = b.split(".").slice(-2).join(".");
    return a === tail || a.endsWith(`.${tail}`);
  } catch {
    return false;
  }
}

/** Login walls, so a gated portal is skipped rather than retried forever. */
const LOGIN_MARKERS = [
  /\bpasswort\b/i,
  /\banmelden\b/i,
  /\bregistrier/i,
  /\blogin\b/i,
  /\bsign in\b/i,
];

/**
 * A page is treated as login-gated only when it shows several login signals *and*
 * offers no files — many portals show a login link in the header while still listing
 * documents publicly, and those must not be skipped.
 */
export function looksLoginGated(html: string, foundFiles: number): boolean {
  if (foundFiles > 0) return false;
  const hits = LOGIN_MARKERS.reduce(
    (count, marker) => count + (marker.test(html) ? 1 : 0),
    0,
  );
  const hasPasswordField = /<input[^>]+type=["']password["']/i.test(html);
  return hasPasswordField || hits >= 3;
}

export interface AnchorHarvestOptions {
  /** Restrict to anchors inside these selectors, when the portal has a documents area. */
  containers?: string[];
  /** Extra predicate for portal-specific link shapes. */
  accept?: (href: string, text: string) => boolean;
  /**
   * Drop links pointing off the page's own site. Default true: a generic pass over a
   * portal otherwise collects the operator's terms-of-use PDF and browser-download
   * banners, both seen in practice on `meinauftrag.rib.de`.
   */
  sameSiteOnly?: boolean;
  maxFiles?: number;
}

/**
 * Collects document links from a page, resolved to absolute URLs and de-duplicated.
 * The anchor's own text becomes the label, which is usually the human name a buyer
 * gave the document.
 */
export function harvestFileLinks(
  html: string,
  baseUrl: string,
  options: AnchorHarvestOptions = {},
): ResolvedFile[] {
  const $ = cheerio.load(html);
  const found = new Map<string, ResolvedFile>();

  const scopes = options.containers?.length
    ? options.containers.flatMap((selector) => $(selector).toArray())
    : [$.root()[0]];

  for (const scope of scopes) {
    $(scope)
      .find("a[href]")
      .each((_, element) => {
        const href = $(element).attr("href");
        if (!href || href.startsWith("#")) return;
        if (/^(mailto|tel|javascript):/i.test(href)) return;

        let absolute: string;
        try {
          absolute = new URL(href, baseUrl).toString();
        } catch {
          return;
        }

        if (options.sameSiteOnly !== false && !isSameSite(absolute, baseUrl)) return;

        const text = $(element).text().replace(/\s+/g, " ").trim();
        const accepted = options.accept
          ? options.accept(absolute, text)
          : isMaybeDownloadUrl(absolute);
        if (!accepted || found.has(absolute)) return;
        if (found.size >= (options.maxFiles ?? 200)) return;

        found.set(absolute, {
          url: absolute,
          fileName: fileNameFromUrl(absolute),
          label: text || null,
        });
      });
  }

  return [...found.values()];
}

/**
 * Removes servlet session tokens such as `;jsessionid=…` from a URL.
 *
 * Java portals (the whole cosinex family) put the session in a path parameter. Left
 * in place it leaks into the derived file name and changes every session, so the same
 * document would be stored under a different name on each run.
 */
export function stripSessionParams(url: string): string {
  return url.replace(/;jsessionid=[^/?#]*/gi, "").replace(/;jsessionid=[^/?#]*/gi, "");
}

export function fileNameFromUrl(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    const last = path.split("/").filter(Boolean).pop();
    if (!last) return null;
    const decoded = decodeURIComponent(last);
    return decoded.includes(".") ? decoded : null;
  } catch {
    return null;
  }
}

export function hostMatcher(...suffixes: string[]) {
  return (url: URL): boolean =>
    suffixes.some(
      (suffix) => url.host === suffix || url.host.endsWith(`.${suffix}`),
    );
}
