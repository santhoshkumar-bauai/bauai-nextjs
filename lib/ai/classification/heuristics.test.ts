import { describe, expect, it } from "vitest";

import { classifyByHeuristics } from "./heuristics.ts";

function byFileName(fileName: string) {
  return classifyByHeuristics({ fileName, firstPageText: "" });
}

function byText(firstPageText: string) {
  return classifyByHeuristics({ fileName: "dokument.pdf", firstPageText });
}

describe("classifyByHeuristics — filenames", () => {
  const cases: Array<[string, string]> = [
    ["212_Teilnahmebedingungen.pdf", "conditions_of_participation"],
    ["Bewerbungsbedingungen_EU.pdf", "conditions_of_participation"],
    ["Aufforderung_zur_Angebotsabgabe.pdf", "conditions_of_participation"],
    ["Besondere_Vertragsbedingungen_BVB.pdf", "contract_conditions"],
    ["ZVB_Stand_2024.docx", "contract_conditions"],
    ["Vertragsentwurf_Rahmenvertrag.pdf", "contract_conditions"],
    ["Leistungsverzeichnis_Los1.pdf", "bill_of_quantities"],
    ["LV_Rohbau.x83", "bill_of_quantities"],
    ["Leistungsbeschreibung_final.docx", "bill_of_quantities"],
    ["Preisblatt_Anlage2.xlsx", "price_sheet"],
    ["EFB-Preis_1a.pdf", "price_sheet"],
    ["Eigenerklärung_zur_Eignung_124.pdf", "suitability_proof_form"],
    ["Formblatt_124_LD.pdf", "suitability_proof_form"],
    ["Wertungsmatrix.xlsx", "award_matrix"],
    ["Zuschlagskriterien_Uebersicht.pdf", "award_matrix"],
    ["Bauzeitenplan_2026.pdf", "deadline_schedule"],
    ["Terminplan.xlsx", "deadline_schedule"],
    ["Baubeschreibung_KiTa.pdf", "technical_specification"],
    ["Technische_Spezifikation_IT.docx", "technical_specification"],
    ["Auftragsbekanntmachung_2026.pdf", "tender_notice"],
    ["Formblatt_213.pdf", "standard_form"],
    ["VHB_631.pdf", "standard_form"],
    ["Anlage_3.pdf", "annex"],
  ];

  for (const [fileName, expected] of cases) {
    it(`${fileName} → ${expected}`, () => {
      expect(byFileName(fileName)?.docClass).toBe(expected);
    });
  }

  it("filename hits carry high confidence", () => {
    expect(byFileName("Leistungsverzeichnis.pdf")?.confidence).toBe(0.9);
  });

  it("annex carries reduced confidence", () => {
    expect(byFileName("Anlage_7.pdf")?.confidence).toBe(0.6);
  });
});

describe("classifyByHeuristics — document text", () => {
  it("finds headings in the text head", () => {
    const result = byText(
      "Vergabeunterlagen\n\nBewerbungsbedingungen für die Vergabe von Bauleistungen\n\n1. Allgemeines",
    );
    expect(result?.docClass).toBe("conditions_of_participation");
    expect(result?.confidence).toBe(0.8);
  });

  it("classifies contract conditions from a BVB heading", () => {
    expect(byText("Besondere Vertragsbedingungen (BVB)\n§ 1 Vertragsfristen")?.docClass).toBe(
      "contract_conditions",
    );
  });

  it("does not classify a document as annex from body text mentions", () => {
    expect(byText("Die Nachweise sind gemäß Anlage 3 einzureichen.")).toBeNull();
  });

  it("ignores text beyond the head window", () => {
    const padded = "x".repeat(5000) + "\nLeistungsverzeichnis\n";
    expect(byText(padded)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(byText("Sehr geehrte Damen und Herren, anbei die Unterlagen.")).toBeNull();
    expect(byFileName("scan_0001.pdf")).toBeNull();
  });

  it("specific numbered form beats generic Formblatt", () => {
    expect(byFileName("Formblatt_124_Eigenerklaerung.pdf")?.docClass).toBe(
      "suitability_proof_form",
    );
  });
});
