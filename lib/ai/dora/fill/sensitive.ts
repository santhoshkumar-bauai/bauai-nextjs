/**
 * Fields a machine must never fill on the user's behalf. Applied as a one-way
 * ratchet in every resolver: the model can ADD sensitivity, never remove it, so
 * a model that returns `sensitive: false` for a signature line is overruled.
 *
 * Shared by the docx and pdf resolvers so the two can never drift apart.
 *
 * BILINGUAL ON PURPOSE. Real German procurement forms say "Rechtsverbindliche
 * Unterschrift" and "Bankverbindung", never "Signature" — an English-only
 * pattern silently auto-fills exactly the fields that must not be auto-filled.
 * This is a heuristic over document prose, which is where German belongs; the
 * identifiers around it stay English.
 *
 * Biased towards over-matching. A false positive costs a field one click of
 * human confirmation; a false negative machine-signs a binding declaration.
 */
const SENSITIVE = new RegExp(
  [
    // Signatures and initials
    "signature",
    "initial",
    "unterschrift",
    "unterzeichn",
    "paraphe",
    // Attestations, consent, declarations of commitment
    "attest",
    "consent",
    "commitment",
    "einwilligung",
    "zustimmung",
    "best(?:ä|ae)tig",
    "verpflichtungserkl",
    "vollmacht",
    // Banking
    "bank",
    "iban",
    "bic",
    "account",
    "kontonummer",
    "kontoinhaber",
    // Guarantees and certification
    "b(?:ü|ue)rgschaft",
    "certif(?:y|ication)",
    "zertifiz",
  ].join("|"),
  "i",
);

/** True when the label/description text, or the model, marks this sensitive. */
export function isSensitiveField(input: {
  label: string;
  description: string;
  modelSaidSensitive: boolean;
}): boolean {
  return (
    input.modelSaidSensitive || SENSITIVE.test(`${input.label} ${input.description}`)
  );
}

export { SENSITIVE };
