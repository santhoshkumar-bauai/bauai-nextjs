/**
 * Sample PDFs for manually exercising Dora's PDF filling.
 *
 * One file per document class, because each takes a different path through
 * the engine:
 *   1. acroform  -> interactive fields, addressed by name           (auto-fills)
 *   2. digital   -> flat text, filled by overlay next to a label    (auto-fills)
 *   3. scanned   -> no text layer, model reads the pixels           (never auto-fills)
 *
 * Deliberately NOT the unit-test fixtures in tests/fixtures/document-fill/pdf/.
 * Those are tuned to specific traps and asserted against; these are meant to
 * look like real German procurement paperwork.
 *
 *   npx tsx scripts/test-fixtures/generate-pdf-samples.mts [outDir]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

const OUT = process.argv[2] || "build/probe/samples";
const A4: [number, number] = [595.28, 841.89];
const INK = rgb(0.1, 0.1, 0.12);
const RULE = rgb(0.72, 0.72, 0.75);

function freeze(doc: PDFDocument) {
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  doc.setTitle("BAU AI — Dora PDF test sample");
}

/** Small layout helper so the three samples look like one family. */
function makeWriter(page: PDFPage, font: PDFFont, bold: PDFFont) {
  let y = 792;
  return {
    get y() { return y; },
    set y(v: number) { y = v; },
    heading(text: string, size = 15) {
      page.drawText(text, { x: 56, y, size, font: bold, color: INK });
      y -= size + 12;
    },
    sub(text: string) {
      page.drawText(text, { x: 56, y, size: 9.5, font, color: rgb(0.38, 0.38, 0.42) });
      y -= 24;
    },
    section(text: string) {
      y -= 6;
      page.drawText(text, { x: 56, y, size: 11, font: bold, color: INK });
      y -= 20;
    },
    para(text: string) {
      page.drawText(text, { x: 56, y, size: 9.5, font, color: INK });
      y -= 18;
    },
    /** A label with a ruled blank after it — the `digital` class shape. */
    blank(label: string, chars = 46) {
      page.drawText(`${label} ${"_".repeat(chars)}`, { x: 56, y, size: 10, font, color: INK });
      y -= 26;
    },
    /** A label with a boxed area beside it — the `acroform` class shape. */
    field(label: string, height = 19): { x: number; y: number; width: number; height: number } {
      page.drawText(label, { x: 56, y: y + 5, size: 10, font, color: INK });
      const box = { x: 250, y, width: 290, height };
      y -= height + 13;
      return box;
    },
    rule() {
      page.drawLine({ start: { x: 56, y }, end: { x: 540, y }, thickness: 0.6, color: RULE });
      y -= 18;
    },
  };
}

const HEADER_SUB =
  "Vergabeverfahren VG-2026-0041 - Neubau Sporthalle, Los 3 Rohbauarbeiten";

/* ------------------------------------------------------ 1. AcroForm sample */
async function acroform(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  freeze(doc);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const p1 = doc.addPage(A4);
  const p2 = doc.addPage(A4);
  const form = doc.getForm();
  const w = makeWriter(p1, font, bold);

  w.heading("Eigenerklärung zur Eignung");
  w.sub(HEADER_SUB);
  w.rule();

  w.section("1. Angaben zum Unternehmen");
  form.createTextField("company.name").addToPage(p1, w.field("Name des Unternehmens"));
  const legalForm = form.createDropdown("company.legalForm");
  legalForm.addOptions(["GmbH", "AG", "GmbH & Co. KG", "SE", "Einzelunternehmen", "GbR"]);
  legalForm.addToPage(p1, w.field("Rechtsform"));
  form.createTextField("company.street").addToPage(p1, w.field("Straße und Hausnummer"));
  form.createTextField("company.city").addToPage(p1, w.field("PLZ und Ort"));
  form.createTextField("company.vat").addToPage(p1, w.field("Umsatzsteuer-Identifikationsnummer"));
  form.createTextField("company.register").addToPage(p1, w.field("Handelsregisternummer"));

  w.section("2. Leistungsfähigkeit");
  form.createTextField("company.employees").addToPage(p1, w.field("Anzahl der Beschäftigten"));
  form.createTextField("company.revenue").addToPage(p1, w.field("Jahresumsatz (letztes Geschäftsjahr)"));
  const trade = form.createRadioGroup("company.trade");
  p1.drawText("Schwerpunkt", { x: 56, y: w.y + 5, size: 10, font, color: INK });
  trade.addOptionToPage("Hochbau", p1, { x: 250, y: w.y + 3, width: 13, height: 13 });
  p1.drawText("Hochbau", { x: 268, y: w.y + 5, size: 9.5, font, color: INK });
  trade.addOptionToPage("Tiefbau", p1, { x: 340, y: w.y + 3, width: 13, height: 13 });
  p1.drawText("Tiefbau", { x: 358, y: w.y + 5, size: 9.5, font, color: INK });
  w.y -= 32;

  const prequal = form.createCheckBox("company.prequalified");
  p1.drawText("Präqualifiziert (PQ-VOB)", { x: 56, y: w.y + 5, size: 10, font, color: INK });
  prequal.addToPage(p1, { x: 250, y: w.y + 3, width: 13, height: 13 });
  w.y -= 32;

  // Pre-filled by the issuer and locked: Dora must leave this alone.
  const reference = form.createTextField("meta.reference");
  reference.setText("VG-2026-0041");
  reference.addToPage(p1, w.field("Aktenzeichen (vom Auftraggeber)"));
  reference.enableReadOnly();

  // Page 2 — the parts a machine must never fill.
  const w2 = makeWriter(p2, font, bold);
  w2.heading("Erklärungen und Unterschrift", 13);
  w2.sub("Bitte prüfen Sie die Angaben auf Seite 1, bevor Sie unterschreiben.");
  w2.rule();
  w2.para("Ich erkläre, dass die vorstehenden Angaben zutreffend und vollständig sind.");
  w2.para("Mir ist bekannt, dass falsche Angaben zum Ausschluss vom Verfahren führen.");
  w2.y -= 10;

  w2.section("3. Bankverbindung");
  form.createTextField("bank.iban").addToPage(p2, w2.field("IBAN"));
  form.createTextField("bank.holder").addToPage(p2, w2.field("Kontoinhaber"));

  w2.section("4. Rechtsverbindliche Unterschrift");
  form.createTextField("signature.place").addToPage(p2, w2.field("Ort, Datum"));
  form.createTextField("signature.name").addToPage(p2, w2.field("Name in Druckbuchstaben"));
  form.createTextField("signature.authorized").addToPage(p2, w2.field("Unterschrift", 34));

  // One field, two widgets: initials on both pages share a single value.
  const initials = form.createTextField("company.initials");
  p1.drawText("Kürzel", { x: 56, y: 92, size: 9, font, color: rgb(0.5, 0.5, 0.55) });
  initials.addToPage(p1, { x: 110, y: 86, width: 70, height: 18 });
  p2.drawText("Kürzel", { x: 56, y: 92, size: 9, font, color: rgb(0.5, 0.5, 0.55) });
  initials.addToPage(p2, { x: 110, y: 86, width: 70, height: 18 });

  form.updateFieldAppearances(font);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/* ------------------------------------------------- 2. Digital (flat) sample */
async function digital(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  freeze(doc);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const p1 = doc.addPage(A4);
  const w = makeWriter(p1, font, bold);

  w.heading("Eigenerklärung zur Eignung");
  w.sub(HEADER_SUB);
  w.rule();

  w.section("1. Angaben zum Unternehmen");
  w.blank("Name des Unternehmens:");
  w.blank("Rechtsform:");
  w.blank("Straße und Hausnummer:");
  w.blank("PLZ und Ort:");
  w.blank("Umsatzsteuer-Identifikationsnummer:", 38);
  w.blank("Handelsregisternummer:");

  w.section("2. Leistungsfähigkeit");
  w.blank("Anzahl der Beschäftigten:");
  w.blank("Jahresumsatz (letztes Geschäftsjahr):", 38);
  w.blank("Anzahl vergleichbarer Referenzprojekte:", 36);

  w.section("3. Kontakt");
  w.blank("Ansprechpartner für dieses Verfahren:", 38);
  w.blank("Telefonnummer:");
  w.blank("E-Mail-Adresse:");

  const p2 = doc.addPage(A4);
  const w2 = makeWriter(p2, font, bold);
  w2.heading("Erklärungen und Unterschrift", 13);
  w2.rule();
  w2.para("Ich erkläre, dass die vorstehenden Angaben zutreffend und vollständig sind.");
  w2.y -= 12;
  w2.section("4. Bankverbindung");
  w2.blank("IBAN:");
  w2.blank("Kontoinhaber:");
  w2.section("5. Rechtsverbindliche Unterschrift");
  w2.blank("Ort, Datum:");
  w2.blank("Name in Druckbuchstaben:");
  w2.blank("Rechtsverbindliche Unterschrift:", 38);

  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/* --------------------------------------------------- 3. Scanned-like sample */

/**
 * A genuine simulated scan: a readable page rasterized to an image and
 * embedded, so the text is visible to a human and to a vision model but
 * completely absent from the text layer.
 *
 * Pass a PNG of a rendered form page as the second CLI argument to build this.
 * Without one, `scannedVector()` below is used instead — same classification,
 * but nothing legible, so it only exercises the "no text" branch and not the
 * model's ability to actually read a page.
 */
async function scannedFromImage(pngPath: string): Promise<Buffer> {
  const { readFileSync } = await import("node:fs");
  const doc = await PDFDocument.create();
  freeze(doc);
  const png = await doc.embedPng(readFileSync(pngPath));
  const page = doc.addPage(A4);
  // Fit the raster to the page, preserving aspect ratio.
  const scale = Math.min(A4[0] / png.width, A4[1] / png.height);
  const w = png.width * scale;
  const h = png.height * scale;
  page.drawImage(png, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2, width: w, height: h });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function scannedVector(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  freeze(doc);
  const page = doc.addPage(A4);

  // Everything is drawn as vectors, so there is no extractable text at all —
  // which is the one property that matters for the `scanned` class. A real
  // scan cannot be synthesized, but this reproduces the behaviour under test.
  const grey = rgb(0.25, 0.25, 0.28);
  const faint = rgb(0.62, 0.62, 0.66);

  // Masthead block
  page.drawRectangle({ x: 56, y: 762, width: 214, height: 15, color: grey });
  page.drawRectangle({ x: 56, y: 742, width: 320, height: 7, color: faint });
  page.drawLine({ start: { x: 56, y: 726 }, end: { x: 540, y: 726 }, thickness: 0.8, color: faint });

  // Label + rule pairs, imitating a printed form
  let y = 690;
  for (let i = 0; i < 12; i++) {
    const labelWidth = 96 + ((i * 37) % 74);
    page.drawRectangle({ x: 56, y: y + 2, width: labelWidth, height: 7, color: faint });
    page.drawLine({
      start: { x: 250, y },
      end: { x: 540, y },
      thickness: 0.7,
      color: grey,
    });
    y -= 34;
    if (i === 5) {
      page.drawRectangle({ x: 56, y: y + 6, width: 150, height: 9, color: grey });
      y -= 26;
    }
  }

  // Signature block
  page.drawLine({ start: { x: 56, y: 210 }, end: { x: 260, y: 210 }, thickness: 0.7, color: grey });
  page.drawRectangle({ x: 56, y: 192, width: 74, height: 6, color: faint });
  page.drawLine({ start: { x: 320, y: 210 }, end: { x: 540, y: 210 }, thickness: 0.7, color: grey });
  page.drawRectangle({ x: 320, y: 192, width: 120, height: 6, color: faint });

  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/* -------------------------------------------------------------------- main */
mkdirSync(OUT, { recursive: true });
const scanSource = process.argv[3];
const samples: Array<[string, () => Promise<Buffer>]> = [
  ["01-acroform-eigenerklaerung.pdf", acroform],
  ["02-digital-eigenerklaerung.pdf", digital],
  [
    "03-scanned-no-text-layer.pdf",
    scanSource ? () => scannedFromImage(scanSource) : scannedVector,
  ],
];
if (!scanSource) {
  console.log(
    "note: no page image supplied, so sample 3 is the vector placeholder.\n" +
      "      For a readable simulated scan, render a form page to PNG and pass it:\n" +
      "      npx tsx scripts/test-fixtures/generate-pdf-samples.mts <outDir> <page.png>\n",
  );
}

for (const [name, build] of samples) {
  const bytes = await build();
  writeFileSync(`${OUT}/${name}`, bytes);
  // Report what the engine will actually classify it as, so a broken sample
  // is obvious here rather than three steps later in the panel.
  const { classifyPdf } = await import("../../lib/ai/dora/fill/pdf/classify.ts");
  const c = await classifyPdf(bytes);
  console.log(
    `${name.padEnd(34)} ${String(bytes.byteLength).padStart(6)}B  ` +
      `class=${c.documentClass.padEnd(8)} pages=${c.pageCount} ` +
      `acroFields=${c.acroFieldCount} chars/page=${Math.round(c.charsPerPage)}`,
  );
}
console.log(`\nwritten to ${OUT}`);
