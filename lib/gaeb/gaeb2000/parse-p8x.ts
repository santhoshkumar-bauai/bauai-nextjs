import type { GaebExtension } from "../format";
import type { GaebParseResult } from "../types";

/**
 * GAEB2000 (.p81–.p86) reader seam. Rarely seen in the wild; kept as an
 * isolated module so a future reader slots in without touching callers.
 */
export function parseP8x(_buffer: Buffer, extension: GaebExtension): GaebParseResult {
  return {
    ok: false,
    error: {
      code: "unsupported_flavor",
      message: `GAEB2000 (.${extension}) parsing is not supported yet`,
    },
  };
}
