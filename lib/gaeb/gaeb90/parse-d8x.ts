import type { GaebExtension } from "../format";
import type { GaebParseResult } from "../types";

/**
 * GAEB90 (.d81–.d86) reader seam. GAEB90 is a fixed-width ISO-8859-1 record
 * format (line-typed `T##` records), entirely unrelated to the XML flavor —
 * it needs a dedicated byte-level decoder, planned as a follow-up tier.
 * Uploads are accepted and archived today; the workspace shows a clear
 * "format not yet supported" state.
 */
export function parseD8x(_buffer: Buffer, extension: GaebExtension): GaebParseResult {
  return {
    ok: false,
    error: {
      code: "unsupported_flavor",
      message: `GAEB90 (.${extension}) parsing is not supported yet`,
    },
  };
}
