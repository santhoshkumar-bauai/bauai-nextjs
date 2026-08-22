import { describe, expect, it } from "vitest";

import { isSensitiveField } from "./sensitive";

const check = (label: string, description = "", modelSaidSensitive = false) =>
  isSensitiveField({ label, description, modelSaidSensitive });

describe("isSensitiveField", () => {
  it("is a one-way ratchet — the model can add, never remove", () => {
    // Model says sensitive about an innocuous label: believed.
    expect(check("Firmenname", "", true)).toBe(true);
    // Model says NOT sensitive about a signature line: overruled.
    expect(check("Authorized Signature", "", false)).toBe(true);
  });

  it("catches the English vocabulary", () => {
    for (const label of [
      "Authorized Signature",
      "Initials",
      "I attest that",
      "Consent to processing",
      "Bank details",
      "IBAN",
      "BIC",
      "Account number",
      "Commitment declaration",
      "ISO certification",
    ]) {
      expect(check(label), label).toBe(true);
    }
  });

  it("catches the German vocabulary real tender forms actually use", () => {
    // The whole point: an English-only pattern auto-signs these.
    for (const label of [
      "Rechtsverbindliche Unterschrift",
      "Unterzeichnung durch",
      "Paraphe",
      "Einwilligung zur Datenverarbeitung",
      "Zustimmung des Bieters",
      "Bestätigung der Angaben",
      "Bestaetigung der Angaben",
      "Verpflichtungserklärung",
      "Vollmacht",
      "Bankverbindung",
      "Kontonummer",
      "Kontoinhaber",
      "Bürgschaft",
      "Buergschaft",
      "Zertifizierung nach ISO 9001",
    ]) {
      expect(check(label), label).toBe(true);
    }
  });

  it("matches on the description too, not only the label", () => {
    expect(check("Feld 12", "Hier ist die Unterschrift einzutragen")).toBe(true);
  });

  it("leaves ordinary business facts fillable", () => {
    for (const label of [
      "Name des Unternehmens",
      "Rechtsform",
      "Straße und Hausnummer",
      "PLZ und Ort",
      "Umsatzsteuer-Identifikationsnummer",
      "Anzahl der Beschäftigten",
      "Jahresumsatz",
      "Handelsregisternummer",
      "Ansprechpartner",
      "Telefonnummer",
    ]) {
      expect(check(label), label).toBe(false);
    }
  });
});
