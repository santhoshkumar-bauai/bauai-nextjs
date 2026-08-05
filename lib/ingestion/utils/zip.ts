import type { Readable } from "node:stream";

import unzipper from "unzipper";

import { ingestionEnv } from "../config/env.ts";
import { malformedPayload, permanent } from "../http/errors.ts";
import { logger } from "../observability/logger.ts";
import { createSha256Stream } from "./hash.ts";

const log = logger.child("zip");

export interface ZipEntry {
  path: string;
  body: Buffer;
}

/**
 * CP437 high range, for ZIP entry names that are not UTF-8.
 *
 * ZIP only guarantees UTF-8 when general-purpose flag bit 11 is set. Plenty of tools
 * still write the legacy OEM code page, so `Eigenerklärung.pdf` arrives as bytes that
 * are invalid UTF-8. Decoding those as UTF-8 yields U+FFFD and **destroys** the
 * original byte, so the name cannot be repaired afterwards — it has to be decoded
 * correctly from the raw bytes in the first place.
 */
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»" +
  "░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

/**
 * Decodes a ZIP entry name from its raw bytes, honouring the UTF-8 flag.
 * Falls back to the already-decoded string when the raw bytes are unavailable.
 */
export function decodeZipEntryName(
  pathBuffer: Buffer | undefined,
  flags: number | undefined,
  fallback: string,
): string {
  if (!pathBuffer?.length) return fallback;

  const isUtf8 = ((flags ?? 0) & 0x800) !== 0;
  if (isUtf8) return pathBuffer.toString("utf8");

  let decoded = "";
  for (const byte of pathBuffer) {
    decoded += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80] ?? "_";
  }
  return decoded;
}

export interface ZipStreamResult {
  entryCount: number;
  /** SHA-256 of the archive bytes, for the run manifest (§6.4). */
  archiveSha256: string;
  archiveByteLength: number;
  skipped: number;
}

/**
 * Streams a ZIP archive entry by entry.
 *
 * Section 14 forbids loading a whole package into memory, and section 16 requires
 * rejecting path traversal and capping decompressed sizes. Both are enforced
 * here so no adapter has to remember them. The archive checksum is computed
 * while reading rather than in a second pass.
 */
export async function forEachZipEntry(
  source: Readable,
  onEntry: (entry: ZipEntry) => Promise<void>,
  options: { include?: (path: string) => boolean } = {},
): Promise<ZipStreamResult> {
  const hasher = createSha256Stream();
  let archiveByteLength = 0;
  let entryCount = 0;
  let skipped = 0;

  source.on("data", (chunk: Buffer) => {
    archiveByteLength += chunk.byteLength;
    hasher.update(chunk);
    if (archiveByteLength > ingestionEnv.limits.maxArchiveBytes) {
      source.destroy(
        permanent(
          `Archive exceeded ${ingestionEnv.limits.maxArchiveBytes} bytes; aborting to avoid exhausting memory and disk`,
        ),
      );
    }
  });

  const parser = source.pipe(unzipper.Parse({ forceStream: true }));

  try {
    for await (const rawEntry of parser) {
      const entry = rawEntry as unzipper.Entry & {
        props?: { pathBuffer?: Buffer };
      };
      // Decoded from the raw bytes rather than trusting unzipper's UTF-8 assumption.
      const entryPath = decodeZipEntryName(
        entry.props?.pathBuffer,
        entry.vars?.flags,
        entry.path,
      );

      if (entry.type === "Directory" || !isSafeEntryPath(entryPath)) {
        if (entry.type !== "Directory") {
          log.warn("rejected unsafe archive entry", { entryPath });
          skipped += 1;
        }
        entry.autodrain();
        continue;
      }

      if (options.include && !options.include(entryPath)) {
        skipped += 1;
        entry.autodrain();
        continue;
      }

      if (entryCount >= ingestionEnv.limits.maxArchiveEntries) {
        entry.autodrain();
        throw permanent(
          `Archive contains more than ${ingestionEnv.limits.maxArchiveEntries} entries`,
        );
      }

      // Rejecting on the declared uncompressed size is the only guard that stops a
      // zip bomb *before* inflating it. The field is present at runtime but absent
      // from unzipper's local-header typings, so it is read defensively and falls
      // back to the compressed size.
      const vars = entry.vars as unknown as {
        uncompressedSize?: number;
        compressedSize?: number;
      };
      const declaredSize = Number(vars?.uncompressedSize ?? vars?.compressedSize ?? 0);

      if (declaredSize > ingestionEnv.limits.maxEntryBytes) {
        log.warn("skipped oversized archive entry", { entryPath, declaredSize });
        skipped += 1;
        entry.autodrain();
        continue;
      }

      const body = await entry.buffer();
      if (body.byteLength > ingestionEnv.limits.maxEntryBytes) {
        log.warn("skipped oversized archive entry after inflation", {
          entryPath,
          byteLength: body.byteLength,
        });
        skipped += 1;
        continue;
      }

      entryCount += 1;
      // A malformed member is quarantined by the caller without aborting the
      // rest of the archive, as required by section 5.1.
      await onEntry({ path: entryPath, body });
    }
  } catch (error) {
    if (error instanceof Error && error.name.startsWith("IngestionError")) throw error;
    throw malformedPayload("Failed to read ZIP archive", error);
  }

  return {
    entryCount,
    archiveSha256: hasher.digest(),
    archiveByteLength,
    skipped,
  };
}

/** Rejects absolute paths, drive letters, and any `..` traversal segment. */
export function isSafeEntryPath(entryPath: string): boolean {
  if (!entryPath || entryPath.length > 400) return false;
  const normalized = entryPath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return false;
  if (normalized.split("/").some((segment) => segment === "..")) return false;
  // Control characters in a member name indicate a crafted archive.
  for (let i = 0; i < normalized.length; i += 1) {
    if (normalized.charCodeAt(i) < 0x20) return false;
  }
  return true;
}
