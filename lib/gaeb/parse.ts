import { gaebFlavor, type GaebExtension } from "./format";
import { parseD8x } from "./gaeb90/parse-d8x";
import { parseP8x } from "./gaeb2000/parse-p8x";
import type { GaebParseResult } from "./types";
import { parseX8x } from "./xml/parse-x8x";

/**
 * Single entry point for every GAEB flavor. Flavor readers stay isolated
 * behind this facade so support tiers can shift (GAEB90 next, GAEB2000 later)
 * without touching any caller.
 */

const MAX_GAEB_BYTES = 100_000_000; // matches WORKSPACE_MAX_FILE_BYTES

export function parseGaeb(buffer: Buffer, extension: GaebExtension): GaebParseResult {
  if (buffer.length === 0) {
    return { ok: false, error: { code: "invalid_xml", message: "empty file" } };
  }
  if (buffer.length > MAX_GAEB_BYTES) {
    return {
      ok: false,
      error: { code: "too_large", message: `file exceeds ${MAX_GAEB_BYTES} bytes` },
    };
  }

  const flavor = gaebFlavor(extension);
  if (flavor === "xml") return parseX8x(buffer, extension);
  if (flavor === "gaeb90") return parseD8x(buffer, extension);
  return parseP8x(buffer, extension);
}
