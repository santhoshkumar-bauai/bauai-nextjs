/**
 * GAEB exchange-format identity, shared by client and server. Pure data — no
 * parsing, no Node APIs — so the upload UI can import it without dragging the
 * parser into the browser bundle.
 *
 * GAEB "Datenaustauschphasen" (DA phases) encode the tender lifecycle in the
 * file extension's last two digits: 81 LV handover, 82 cost estimate, 83 offer
 * request, 84 priced offer, 85 side offer, 86 award. The leading letter picks
 * the container: `x` = GAEB DA XML 3.x, `d` = GAEB90 (fixed-width text),
 * `p` = GAEB2000.
 */

export const GAEB_EXTENSIONS = [
  "x81",
  "x82",
  "x83",
  "x84",
  "x85",
  "x86",
  "d81",
  "d82",
  "d83",
  "d84",
  "d85",
  "d86",
  "p81",
  "p82",
  "p83",
  "p84",
  "p85",
  "p86",
] as const;

export type GaebExtension = (typeof GAEB_EXTENSIONS)[number];

export type GaebFlavor = "xml" | "gaeb90" | "gaeb2000";

export type GaebPhase = 81 | 82 | 83 | 84 | 85 | 86;

export function isGaebExtension(value: string): value is GaebExtension {
  return (GAEB_EXTENSIONS as readonly string[]).includes(value.toLowerCase());
}

export function gaebPhase(extension: GaebExtension): GaebPhase {
  return Number(extension.slice(1)) as GaebPhase;
}

export function gaebFlavor(extension: GaebExtension): GaebFlavor {
  const letter = extension[0];
  if (letter === "x") return "xml";
  if (letter === "d") return "gaeb90";
  return "gaeb2000";
}

/** Display label for badges: "X83", "D84", ... */
export function gaebPhaseLabel(extension: GaebExtension): string {
  return extension.toUpperCase();
}

/**
 * Phases whose bill of quantities is meaningfully priceable by a bidder.
 * 85 (side offer) and 86 (award) are downstream artifacts — view-only.
 */
export function gaebPhaseSupportsPricing(phase: GaebPhase): boolean {
  return phase === 81 || phase === 82 || phase === 83 || phase === 84;
}
