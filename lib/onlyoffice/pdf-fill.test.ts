import { createHash } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { buildPdfManifest } from "@/lib/ai/dora/fill/pdf/manifest";
import {
  makeAcroFormFixture,
  makeDigitalFixture,
} from "@/tests/fixtures/document-fill/pdf/make-fixtures";

import {
  fillPdfBuffer,
  narrowPdfInstructions,
  verifyFilledPdf,
  type PdfFillCandidate,
  type PdfFillInstruction,
} from "./pdf-fill";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let acroform: Buffer;
let digital: Buffer;

beforeAll(async () => {
  [acroform, digital] = await Promise.all([makeAcroFormFixture(), makeDigitalFixture()]);
});

/** The AcroForm arm alone, so spread-overrides of fieldType stay well typed. */
type AcroInstruction = Extract<PdfFillInstruction, { strategy: "pdf_acroform" }>;

const text = (id: string, fieldName: string, value: string, page = 0): AcroInstruction => ({
  id,
  value,
  strategy: "pdf_acroform",
  nodeId: `af:${id}`,
  page,
  fieldName,
  fieldType: "text",
  widgetCount: 1,
  rect: { x: 240, y: 716, width: 300, height: 18 },
});

/** Build a real overlay instruction from the fixture's own manifest. */
async function overlayFor(anchorText: string): Promise<PdfFillInstruction> {
  const manifest = await buildPdfManifest(digital);
  const { resolvePdfDiscoveredFields } = await import("@/lib/ai/dora/fill/pdf/resolve-pdf");
  const line = manifest.lines.find((l) => l.text.includes(anchorText))!;
  const { helveticaMeasurer } = await import("@/lib/ai/dora/fill/pdf/measure");
  const [field] = resolvePdfDiscoveredFields({
    measureText: await helveticaMeasurer(),
    discovery: {
      fields: [
        {
          nodeId: line.nodeId,
          kind: "overlay_text",
          label: "Feld",
          description: "",
          required: false,
          sensitive: false,
          page: line.page,
          anchorText,
          rect: null,
          value: "BAU Testbau GmbH",
          confidence: 0.95,
          evidenceReferences: [],
          reason: "",
        },
      ],
    },
    manifest,
    evidence: new Map(),
  });
  return { id: "ov1", value: "BAU Testbau GmbH", ...field.locator! } as PdfFillInstruction;
}

/* --------------------------------------------------------- source integrity */

describe("source immutability", () => {
  it("never mutates the source buffer", async () => {
    const before = sha(acroform);
    await fillPdfBuffer(acroform, [text("a", "company.name", "BAU Testbau GmbH")]);
    expect(sha(acroform)).toBe(before);
  });

  it("leaves the page count untouched", async () => {
    const out = await fillPdfBuffer(acroform, [text("a", "company.name", "X")]);
    const { PDFDocument } = await import("pdf-lib");
    expect((await PDFDocument.load(out)).getPageCount()).toBe(2);
  });
});

/* ------------------------------------------------------------ phase 1: keys */

describe("phase 1 — target identity", () => {
  it("rejects two instructions targeting one AcroForm field", async () => {
    await expect(
      fillPdfBuffer(acroform, [
        text("a", "company.name", "One"),
        text("b", "company.name", "Two"),
      ]),
    ).rejects.toThrow("duplicate_fill_locator");
  });

  it("rejects a vision locator — nothing verified its position", async () => {
    const vision = {
      id: "v",
      value: "X",
      strategy: "pdf_overlay_vision",
      nodeId: "vis:0:1:2",
      page: 0,
      rect: { x: 10, y: 10, width: 100, height: 14 },
      baseline: { x: 10, y: 12 },
      fontSize: 11,
      nearestText: "",
    } as unknown as PdfFillCandidate;
    await expect(fillPdfBuffer(acroform, [vision])).rejects.toThrow(
      "vision_locator_not_generatable",
    );
    expect(() => narrowPdfInstructions([vision])).toThrow("vision_locator_not_generatable");
  });

  it("rejects a Word locator routed to the PDF engine", async () => {
    const docx = {
      id: "d",
      value: "X",
      strategy: "form_key",
      nodeId: "n",
      path: "body/0",
      formKey: "COMPANY_NAME",
    } as unknown as PdfFillCandidate;
    await expect(fillPdfBuffer(acroform, [docx])).rejects.toThrow("docx_locator_in_pdf");
  });
});

/* -------------------------------------------------------- phase 2: preflight */

describe("phase 2 — preflight is all-or-nothing", () => {
  it("uses the same error shape as the Word engine when a target is missing", async () => {
    await expect(
      fillPdfBuffer(acroform, [text("missing", "company.nope", "X")]),
    ).rejects.toThrow("locator_preflight_failed:missing:0");
  });

  it("refuses when the field changed type since analysis", async () => {
    const wrong = { ...text("t", "company.prequalified", "X"), fieldType: "text" as const };
    await expect(fillPdfBuffer(acroform, [wrong])).rejects.toThrow(
      "locator_field_type_changed:t",
    );
  });

  it("refuses a read-only field", async () => {
    await expect(
      fillPdfBuffer(acroform, [text("ro", "meta.reference", "VG-9999")]),
    ).rejects.toThrow("locator_read_only:ro");
  });

  it("refuses a choice value that is not an allowed option", async () => {
    const dropdown: AcroInstruction = {
      ...text("dd", "company.legalForm", "Limited"),
      fieldType: "dropdown",
    };
    await expect(fillPdfBuffer(acroform, [dropdown])).rejects.toThrow(
      "locator_value_rejected:dd",
    );
  });

  it("writes NOTHING when any one target fails preflight", async () => {
    // The whole point of the phase split: a good instruction must not land
    // just because it was listed before a bad one.
    await expect(
      fillPdfBuffer(acroform, [
        text("good", "company.name", "BAU Testbau GmbH"),
        text("bad", "company.nope", "X"),
      ]),
    ).rejects.toThrow(/locator_preflight_failed/);
  });

  it("refuses when the manifest no longer matches the bytes", async () => {
    await expect(
      fillPdfBuffer(acroform, [text("a", "company.name", "X")], {
        expectedManifestHash: "0".repeat(64),
      }),
    ).rejects.toThrow("pdf_manifest_mismatch");
  });

  it("accepts a matching manifest hash", async () => {
    const { manifestHash } = await buildPdfManifest(acroform);
    await expect(
      fillPdfBuffer(acroform, [text("a", "company.name", "X")], {
        expectedManifestHash: manifestHash,
      }),
    ).resolves.toBeInstanceOf(Buffer);
  });
});

/* ------------------------------------------------------------- encoding */

describe("encoding preflight", () => {
  it("writes German umlauts through Helvetica with no fallback font", async () => {
    const value = "Königsallee 47a, 40212 Düsseldorf — Größe 1.250 m²";
    const out = await fillPdfBuffer(acroform, [text("a", "company.street", value)]);
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(out);
    expect(doc.getForm().getTextField("company.street").getText()).toBe(value);
  });

  it("refuses a value WinAnsi cannot represent, before writing anything", async () => {
    await expect(
      fillPdfBuffer(acroform, [
        text("ok", "company.name", "BAU Testbau GmbH"),
        text("pl", "company.city", "Łódź"),
      ]),
    ).rejects.toThrow("pdf_value_not_encodable:pl");
  });
});

/* --------------------------------------------------------- phase 3: writes */

describe("phase 3 — AcroForm writes", () => {
  it("fills every field type and reads them all back", async () => {
    const fields: AcroInstruction[] = [
      text("n", "company.name", "BAU Testbau GmbH"),
      { ...text("c", "company.prequalified", "ja"), fieldType: "checkbox" },
      { ...text("d", "company.legalForm", "GmbH & Co. KG"), fieldType: "dropdown" },
      { ...text("r", "company.trade", "Tiefbau"), fieldType: "radio" },
    ];
    const out = await fillPdfBuffer(acroform, fields);
    const { PDFDocument } = await import("pdf-lib");
    const form = (await PDFDocument.load(out)).getForm();
    expect(form.getTextField("company.name").getText()).toBe("BAU Testbau GmbH");
    expect(form.getCheckBox("company.prequalified").isChecked()).toBe(true);
    expect(form.getDropdown("company.legalForm").getSelected()).toEqual(["GmbH & Co. KG"]);
    expect(form.getRadioGroup("company.trade").getSelected()).toBe("Tiefbau");
    expect(await verifyFilledPdf(out, fields, 2)).toEqual({ ok: true });
  });

  it("gives a linked-widget field one value in both places", async () => {
    const field: AcroInstruction = { ...text("i", "company.initials", "BTG"), widgetCount: 2 };
    const out = await fillPdfBuffer(acroform, [field]);
    const { PDFDocument } = await import("pdf-lib");
    const target = (await PDFDocument.load(out)).getForm().getTextField("company.initials");
    expect(target.getText()).toBe("BTG");
    expect(target.acroField.getWidgets()).toHaveLength(2);
    // Both widgets must render, not just the first.
    expect(await verifyFilledPdf(out, [field], 2)).toEqual({ ok: true });
  });

  it("leaves every untargeted field exactly as it was", async () => {
    const out = await fillPdfBuffer(acroform, [text("n", "company.name", "BAU Testbau GmbH")]);
    const { PDFDocument } = await import("pdf-lib");
    const form = (await PDFDocument.load(out)).getForm();
    expect(form.getTextField("company.vat").getText()).toBeUndefined();
    expect(form.getTextField("signature.authorized").getText()).toBeUndefined();
    expect(form.getTextField("bank.iban").getText()).toBeUndefined();
    // Read-only content is preserved, not blanked.
    expect(form.getTextField("meta.reference").getText()).toBe("VG-2026-0041");
  });

  it("keeps the form live so the user can still correct it", async () => {
    const out = await fillPdfBuffer(acroform, [text("n", "company.name", "X")]);
    const { PDFDocument } = await import("pdf-lib");
    expect((await PDFDocument.load(out)).getForm().getFields().length).toBeGreaterThan(0);
  });

  it("flattens only when explicitly asked", async () => {
    const out = await fillPdfBuffer(acroform, [text("n", "company.name", "X")], {
      flatten: true,
    });
    const { PDFDocument } = await import("pdf-lib");
    expect((await PDFDocument.load(out)).getForm().getFields()).toHaveLength(0);
  });
});

describe("phase 3 — overlay writes", () => {
  it("draws the value inside its target area", async () => {
    const field = await overlayFor("Name des Unternehmens:");
    const out = await fillPdfBuffer(digital, [field]);
    // verifyFilledPdf re-extracts and checks the value landed within rect±2pt,
    // which is what catches a wrong-y bug.
    expect(await verifyFilledPdf(out, [field], 2)).toEqual({ ok: true });
  });

  it("covers a placeholder run before drawing over it", async () => {
    const field = await overlayFor("Rechtsform:");
    expect(field.strategy === "pdf_overlay_text" && field.whiteout).toBe(true);
    await expect(fillPdfBuffer(digital, [field])).resolves.toBeInstanceOf(Buffer);
  });

  it("refuses an anchor that is no longer unique in the document", async () => {
    const field = await overlayFor("Name des Unternehmens:");
    const stale = {
      ...field,
      anchorText: "Ansprechpartner:",
    } as PdfFillInstruction;
    await expect(fillPdfBuffer(digital, [stale])).rejects.toThrow(
      "locator_preflight_failed:ov1:2",
    );
  });
});

/* ---------------------------------------------------------- verification */

describe("verifyFilledPdf", () => {
  it("reports a value that did not land", async () => {
    const out = await fillPdfBuffer(acroform, [text("n", "company.name", "Written")]);
    const lying = text("n", "company.name", "Never written");
    const result = await verifyFilledPdf(out, [lying], 2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures[0]).toMatchObject({ id: "n" });
  });

  it("reports a changed page count", async () => {
    const out = await fillPdfBuffer(acroform, [text("n", "company.name", "X")]);
    const result = await verifyFilledPdf(out, [], 99);
    expect(result.ok).toBe(false);
  });
});
