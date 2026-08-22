import type { MeasureText } from "./resolve-pdf";

/**
 * A text measurer backed by real Helvetica metrics.
 *
 * Overlay geometry has to know where a label actually ENDS. Estimating that
 * from character counts is badly wrong in a proportional face and the error
 * grows with label length, which renders as leftover placeholder characters in
 * front of the value.
 *
 * Helvetica stands in for whatever the document really uses. Almost every
 * German procurement form is set in Helvetica or Arial, which share metrics;
 * anything else is close enough that the residual is under a point, and the
 * consequence of being slightly short is a hairline sliver rather than an
 * erased label.
 */
export async function helveticaMeasurer(): Promise<MeasureText> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  return (text: string, size: number) => {
    try {
      return font.widthOfTextAtSize(text, size);
    } catch {
      // Un-encodable characters in the LABEL must not break geometry; fall
      // back to an average-width estimate for the whole string.
      return text.length * size * 0.5;
    }
  };
}
