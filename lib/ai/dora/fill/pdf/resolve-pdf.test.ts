import { beforeAll, describe, expect, it } from "vitest";

import {
  makeAcroFormFixture,
  makeDigitalFixture,
} from "@/tests/fixtures/document-fill/pdf/make-fixtures";

import type { DocumentFillEvidence } from "../types";
import { buildPdfManifest, type PdfManifest } from "./manifest";
import { occurrenceCount, resolvePdfDiscoveredFields, spanAfterAnchor } from "./resolve-pdf";
import type { PdfFillDiscovery } from "./schema-pdf";

let acroManifest: PdfManifest;
let digitalManifest: PdfManifest;

beforeAll(async () => {
  const [acro, digital] = await Promise.all([makeAcroFormFixture(), makeDigitalFixture()]);
  [acroManifest, digitalManifest] = await Promise.all([
    buildPdfManifest(acro),
    buildPdfManifest(digital),
  ]);
});

const EVIDENCE = new Map<string, DocumentFillEvidence>([
  ["company.name", { source: "company_profile", reference: "company.name", excerpt: "BAU Testbau GmbH" }],
]);

type Candidate = PdfFillDiscovery["fields"][number];

function candidate(over: Partial<Candidate>): Candidate {
  return {
    nodeId: "",
    kind: "acroform",
    label: "Firmenname",
    description: "",
    required: false,
    sensitive: false,
    page: 0,
    anchorText: "",
    rect: null,
    value: "BAU Testbau GmbH",
    confidence: 0.95,
    evidenceReferences: ["company.name"],
    reason: "",
    ...over,
  } as Candidate;
}

function resolveOne(manifest: PdfManifest, over: Partial<Candidate>) {
  return resolvePdfDiscoveredFields({
    discovery: { fields: [candidate(over)] },
    manifest,
    evidence: EVIDENCE,
  })[0];
}

const nodeOf = (manifest: PdfManifest, fieldName: string) =>
  manifest.acroFields.find((f) => f.fieldName === fieldName)!.nodeId;

const lineOf = (manifest: PdfManifest, contains: string) =>
  manifest.lines.find((l) => l.text.includes(contains))!;

/* ------------------------------------------------------------------ acroform */

describe("acroform locators", () => {
  it("resolves a plain text field to a ready state", () => {
    const field = resolveOne(acroManifest, { nodeId: nodeOf(acroManifest, "company.name") });
    expect(field.state).toBe("ready");
    expect(field.locator).toMatchObject({
      strategy: "pdf_acroform",
      fieldName: "company.name",
      fieldType: "text",
      page: 0,
    });
  });

  it("accepts a field with linked widgets — one value, several places", () => {
    const field = resolveOne(acroManifest, {
      nodeId: nodeOf(acroManifest, "company.initials"),
      label: "Kürzel",
      value: "BTG",
    });
    expect(field.state).toBe("ready");
    expect(field.locator).toMatchObject({ strategy: "pdf_acroform", widgetCount: 2 });
  });

  it("refuses two DISTINCT fields sharing a name, which getField cannot disambiguate", () => {
    const forged: PdfManifest = {
      ...acroManifest,
      acroFields: [
        ...acroManifest.acroFields,
        { ...acroManifest.acroFields[0], nodeId: "af:99" },
      ],
    };
    const field = resolveOne(forged, { nodeId: forged.acroFields[0].nodeId });
    expect(field.locator).toBeNull();
    expect(field.reason).toMatch(/share this name/i);
  });

  it("refuses a read-only field", () => {
    const field = resolveOne(acroManifest, {
      nodeId: nodeOf(acroManifest, "meta.reference"),
      label: "Aktenzeichen",
      value: "VG-9999",
    });
    expect(field.locator).toBeNull();
    expect(field.reason).toMatch(/read-only/i);
  });

  it("holds a German signature label as manual even when the model says otherwise", () => {
    const field = resolveOne(acroManifest, {
      nodeId: nodeOf(acroManifest, "signature.authorized"),
      label: "Rechtsverbindliche Unterschrift",
      sensitive: false,
      value: "Max Mustermann",
    });
    expect(field.sensitive).toBe(true);
    expect(field.state).toBe("manual");
    // It KEEPS its locator: manual means "never auto-applied", not "unknown
    // where". The panel uses it to navigate the user to the place to sign.
    expect(field.locator).toMatchObject({ strategy: "pdf_acroform" });
  });

  it("refuses a locator for a true /FT /Sig field, whatever its label says", () => {
    const signatureNode = nodeOf(acroManifest, "signature.authorized");
    const forged: PdfManifest = {
      ...acroManifest,
      acroFields: acroManifest.acroFields.map((f) =>
        f.nodeId === signatureNode ? { ...f, fieldType: "signature" as const } : f,
      ),
    };
    const field = resolveOne(forged, {
      nodeId: signatureNode,
      label: "Feld 12",
      sensitive: false,
      value: "Max Mustermann",
    });
    expect(field.sensitive).toBe(true);
    expect(field.state).toBe("manual");
    expect(field.locator).toBeNull();
  });

  it("treats an IBAN field as sensitive from its label alone", () => {
    const field = resolveOne(acroManifest, {
      nodeId: nodeOf(acroManifest, "bank.iban"),
      label: "IBAN",
      sensitive: false,
      value: "DE02120300000000202051",
    });
    expect(field.state).toBe("manual");
  });

  it("refuses a dropdown value that is not one of the options", () => {
    const field = resolveOne(acroManifest, {
      nodeId: nodeOf(acroManifest, "company.legalForm"),
      label: "Rechtsform",
      value: "Limited",
    });
    expect(field.locator).toBeNull();
    expect(field.reason).toMatch(/allowed options/i);
  });

  it("accepts a dropdown value that is an exact option", () => {
    const field = resolveOne(acroManifest, {
      nodeId: nodeOf(acroManifest, "company.legalForm"),
      label: "Rechtsform",
      value: "GmbH & Co. KG",
    });
    expect(field.state).toBe("ready");
  });

  it("accepts a natural yes/no answer for a checkbox", () => {
    const field = resolveOne(acroManifest, {
      nodeId: nodeOf(acroManifest, "company.prequalified"),
      label: "Präqualifiziert",
      value: "ja",
    });
    expect(field.state).toBe("ready");
  });

  it("refuses an invented field id", () => {
    const field = resolveOne(acroManifest, { nodeId: "af:9999" });
    expect(field.locator).toBeNull();
    expect(field.reason).toMatch(/no form field/i);
  });
});

/* -------------------------------------------------------------- overlay_text */

describe("overlay_text locators", () => {
  it("resolves a unique label and derives the write span from the manifest", () => {
    const line = lineOf(digitalManifest, "Name des Unternehmens");
    const field = resolveOne(digitalManifest, {
      kind: "overlay_text",
      nodeId: line.nodeId,
      anchorText: "Name des Unternehmens:",
    });
    expect(field.state).toBe("ready");
    const locator = field.locator as Extract<
      NonNullable<typeof field.locator>,
      { strategy: "pdf_overlay_text" }
    >;
    expect(locator.strategy).toBe("pdf_overlay_text");
    // The write position sits to the RIGHT of the label, on its baseline.
    expect(locator.baseline.x).toBeGreaterThan(line.baseline.x);
    expect(locator.baseline.y).toBeCloseTo(line.baseline.y, 5);
    expect(locator.rect.width).toBeGreaterThan(8);
    // The blank is a placeholder run on a digital page, so cover it.
    expect(locator.whiteout).toBe(true);
  });

  it("refuses an anchor that appears on more than one page", () => {
    // "Ansprechpartner:" is deliberately duplicated across pages 0 and 1.
    const line = lineOf(digitalManifest, "Ansprechpartner");
    const field = resolveOne(digitalManifest, {
      kind: "overlay_text",
      nodeId: line.nodeId,
      anchorText: "Ansprechpartner:",
    });
    expect(field.locator).toBeNull();
    expect(field.reason).toMatch(/appears 2 times/i);
  });

  it("refuses the underscore run as an anchor, because every blank is identical", () => {
    // This is exactly what probe P2.B showed the model reaching for.
    const line = lineOf(digitalManifest, "Rechtsform");
    const field = resolveOne(digitalManifest, {
      kind: "overlay_text",
      nodeId: line.nodeId,
      anchorText: "______________________________",
    });
    expect(field.locator).toBeNull();
    expect(field.reason).toMatch(/ambiguous|appears \d+ times/i);
  });

  it("refuses an anchor that is not on the named line", () => {
    const line = lineOf(digitalManifest, "Rechtsform");
    const field = resolveOne(digitalManifest, {
      kind: "overlay_text",
      nodeId: line.nodeId,
      anchorText: "Name des Unternehmens:",
    });
    expect(field.locator).toBeNull();
    expect(field.reason).toMatch(/not on that line/i);
  });

  it("refuses an invented line id", () => {
    const field = resolveOne(digitalManifest, {
      kind: "overlay_text",
      nodeId: "tl:0:9999",
      anchorText: "Rechtsform:",
    });
    expect(field.locator).toBeNull();
  });
});

/* ------------------------------------------------------------ overlay_vision */

describe("overlay_vision can never auto-apply", () => {
  const visionCandidate = (over: Partial<Candidate> = {}): Partial<Candidate> => ({
    kind: "overlay_vision",
    nodeId: "",
    page: 0,
    rect: { x: 200, y: 600, width: 220, height: 16 },
    anchorText: "Firmenname",
    ...over,
  });

  it("never reaches ready at ANY confidence, with full evidence", () => {
    for (const confidence of [0, 0.25, 0.5, 0.7, 0.89, 0.9, 0.95, 0.99, 1]) {
      const field = resolveOne(digitalManifest, visionCandidate({ confidence }));
      expect(field.locator?.strategy, `confidence ${confidence}`).toBe("pdf_overlay_vision");
      expect(field.state, `confidence ${confidence}`).toBe("needs_review");
    }
  });

  it("still builds a locator, so the panel can navigate to it", () => {
    const field = resolveOne(digitalManifest, visionCandidate());
    expect(field.locator).toMatchObject({ strategy: "pdf_overlay_vision", page: 0 });
  });

  it("falls to missing without a value and manual when sensitive", () => {
    expect(resolveOne(digitalManifest, visionCandidate({ value: null })).state).toBe("missing");
    expect(
      resolveOne(digitalManifest, visionCandidate({ label: "Unterschrift" })).state,
    ).toBe("manual");
  });

  it("refuses an area outside the page", () => {
    const field = resolveOne(
      digitalManifest,
      visionCandidate({ rect: { x: 500, y: 800, width: 300, height: 100 } }),
    );
    expect(field.locator).toBeNull();
    expect(field.reason).toMatch(/outside the page/i);
  });

  it("refuses a degenerate area", () => {
    const field = resolveOne(
      digitalManifest,
      visionCandidate({ rect: { x: 100, y: 100, width: 3, height: 2 } }),
    );
    expect(field.locator).toBeNull();
    expect(field.reason).toMatch(/too small/i);
  });
});

/* -------------------------------------------------------------- shared ladder */

describe("confidence ladder", () => {
  const node = () => nodeOf(acroManifest, "company.name");

  it("demotes below 0.9 and rejects below 0.7", () => {
    expect(resolveOne(acroManifest, { nodeId: node(), confidence: 0.95 }).state).toBe("ready");
    expect(resolveOne(acroManifest, { nodeId: node(), confidence: 0.8 }).state).toBe("needs_review");
    expect(resolveOne(acroManifest, { nodeId: node(), confidence: 0.5 }).state).toBe("needs_review");
  });

  it("demotes when no supplied evidence reference actually exists", () => {
    const field = resolveOne(acroManifest, {
      nodeId: node(),
      evidenceReferences: ["company.invented"],
    });
    expect(field.evidence).toEqual([]);
    expect(field.state).toBe("needs_review");
  });

  it("reports a field with no defensible value as missing, not as an error", () => {
    expect(resolveOne(acroManifest, { nodeId: node(), value: null }).state).toBe("missing");
  });

  it("never lets a scanned document produce a ready field", () => {
    const scannedish: PdfManifest = {
      ...acroManifest,
      classification: { ...acroManifest.classification, documentClass: "scanned" },
    };
    expect(resolveOne(scannedish, { nodeId: node(), confidence: 1 }).state).toBe("needs_review");
  });

  it("gives every field a distinct stable id", () => {
    const fields = resolvePdfDiscoveredFields({
      discovery: {
        fields: [
          candidate({ nodeId: nodeOf(acroManifest, "company.name") }),
          candidate({ nodeId: nodeOf(acroManifest, "company.vat"), label: "USt-IdNr." }),
        ],
      },
      manifest: acroManifest,
      evidence: EVIDENCE,
    });
    expect(fields[0].id).not.toBe(fields[1].id);
    expect(fields[0].id).toMatch(/^[0-9a-f]{24}$/);
  });
});

/* ------------------------------------------------------------------- helpers */

describe("occurrenceCount", () => {
  it("counts across every line of every page", () => {
    expect(occurrenceCount(digitalManifest.lines, "Ansprechpartner:")).toBe(2);
    expect(occurrenceCount(digitalManifest.lines, "Name des Unternehmens:")).toBe(1);
    expect(occurrenceCount(digitalManifest.lines, "nicht vorhanden")).toBe(0);
  });

  it("returns zero for an empty needle rather than looping", () => {
    expect(occurrenceCount(digitalManifest.lines, "")).toBe(0);
  });
});

describe("spanAfterAnchor", () => {
  it("starts to the right of the anchor and stays on its baseline", () => {
    const line = lineOf(digitalManifest, "PLZ und Ort");
    const span = spanAfterAnchor(line, "PLZ und Ort:", 595.28)!;
    expect(span).not.toBeNull();
    expect(span.baseline.y).toBeCloseTo(line.baseline.y, 5);
    expect(span.baseline.x).toBeGreaterThan(line.baseline.x);
    expect(span.rect.width).toBeGreaterThan(8);
  });

  it("covers from the anchor's end, so no placeholder stub survives", () => {
    // The box must start BEFORE the text: sharing an origin leaves the first
    // few points of the underscore run visible in front of the value.
    const line = lineOf(digitalManifest, "PLZ und Ort");
    const span = spanAfterAnchor(line, "PLZ und Ort:", 595.28)!;
    expect(span.rect.x).toBeLessThan(span.baseline.x);
    // ...and the box must still reach the end of the placeholder run.
    expect(span.rect.x + span.rect.width).toBeGreaterThanOrEqual(
      line.rect.x + line.rect.width - 0.01,
    );
  });

  it("returns null when the anchor is not on the line", () => {
    const line = lineOf(digitalManifest, "PLZ und Ort");
    expect(spanAfterAnchor(line, "Nicht da", 595.28)).toBeNull();
  });
});
