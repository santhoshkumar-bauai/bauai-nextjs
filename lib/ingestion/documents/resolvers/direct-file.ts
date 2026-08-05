import { logger } from "../../observability/logger.ts";
import type { DocumentResolver, ResolveContext, ResolveOutcome } from "../types.ts";
import {
  fileNameFromUrl,
  harvestFileLinks,
  isDefinitelyFileUrl,
  isMaybeDownloadUrl,
  looksLoginGated,
} from "./shared.ts";

const log = logger.child("documents.resolver.generic");

/**
 * Fallback resolver used when no platform resolver claims the host.
 *
 * Three cases, in order of confidence:
 *
 *  1. the URL carries a real document extension — take it as a file;
 *  2. it looks like a download endpoint — confirm with a HEAD, because
 *     `/notice/<id>/documents` and `tenderdocuments.html?id=…` both look like
 *     downloads and are pages;
 *  3. otherwise parse it as a page and collect the file links on it.
 *
 * The page pass is the floor, not the target. It only knows what a file link
 * generally looks like, so a portal with real volume deserves its own resolver that
 * knows where the document table lives.
 */
export const directFileResolver: DocumentResolver = {
  platform: "generic",

  // Claims nothing outright; the registry uses it as the fallback.
  matches: () => false,

  async resolve({ url, http, signal }: ResolveContext): Promise<ResolveOutcome> {
    const href = url.toString();

    if (isDefinitelyFileUrl(href)) {
      return { files: [{ url: href, fileName: fileNameFromUrl(href) }] };
    }

    if (isMaybeDownloadUrl(href)) {
      const probed = await probe(href, http, signal);
      if (probed) return { files: [probed] };
    }

    const page = await http.html(href, signal);
    const files = harvestFileLinks(page.body, page.finalUrl);

    if (files.length) return { files };

    if (looksLoginGated(page.body, files.length)) {
      return { skip: "LOGIN_REQUIRED" };
    }
    return { skip: "NO_FILES_FOUND" };
  },
};

/**
 * Asks the server whether a URL is a file. Returns null when the answer is "a page"
 * or when the question could not be asked — several portals answer HEAD with 405 or
 * 403, and that must fall through to page parsing rather than fail the document.
 */
async function probe(
  href: string,
  http: ResolveContext["http"],
  signal?: AbortSignal,
): Promise<{ url: string; fileName: string | null; declaredMimeType: string } | null> {
  try {
    const head = await http.head(href, signal);
    if (head.mimeType && !/html|xml|json/i.test(head.mimeType)) {
      return {
        url: href,
        fileName: fileNameFromUrl(href),
        declaredMimeType: head.mimeType,
      };
    }
  } catch (error) {
    log.debug("HEAD probe unavailable; treating as a page", {
      url: href,
      error: String(error).slice(0, 120),
    });
  }
  return null;
}
