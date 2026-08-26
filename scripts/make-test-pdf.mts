/**
 * Generates a realistic German tender self-declaration form for testing the
 * PDF fill path.
 *
 *   npm run test:pdf                 # writes fixtures/eigenerklaerung-test.pdf
 *   npm run test:pdf -- --acroform   # same form with real AcroForm fields
 *
 * Two variants on purpose, because they exercise different halves of the
 * analyzer: without AcroForm fields the model has to anchor overlay text to
 * the label preceding each blank, which is the harder path and the one that
 * regressed before (the model reaches for the underscore run instead of the
 * label). With them, the manifest supplies the geometry and the model only
 * has to map values onto field names.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const withAcroForm = process.argv.includes("--acroform");

const doc = await PDFDocument.create();
doc.setTitle("Eigenerklärung zur Eignung");
doc.setAuthor("Vergabestelle Musterstadt");

const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const form = withAcroForm ? doc.getForm() : null;

const A4: [number, number] = [595, 842];
const LEFT = 56;
const RIGHT = 539;
const BLACK = rgb(0.1, 0.1, 0.1);
const GREY = rgb(0.45, 0.45, 0.45);
const RULE = rgb(0.72, 0.72, 0.72);

let page = doc.addPage(A4);
let y = 786;
let fieldIndex = 0;

function newPage() {
  page = doc.addPage(A4);
  y = 786;
}

function ensure(space: number) {
  if (y - space < 64) newPage();
}

function heading(text: string, size = 15) {
  ensure(40);
  page.drawText(text, { x: LEFT, y, size, font: bold, color: BLACK });
  y -= size + 10;
}

function section(text: string) {
  ensure(38);
  y -= 8;
  page.drawText(text, { x: LEFT, y, size: 11, font: bold, color: BLACK });
  y -= 6;
  page.drawLine({
    start: { x: LEFT, y },
    end: { x: RIGHT, y },
    thickness: 0.7,
    color: RULE,
  });
  y -= 16;
}

function note(text: string) {
  ensure(24);
  for (const line of wrap(text, 96)) {
    page.drawText(line, { x: LEFT, y, size: 8.5, font, color: GREY });
    y -= 12;
  }
  y -= 4;
}

/** A labelled blank. The label is what the analyzer must anchor to. */
function field(label: string, opts: { width?: number; name?: string } = {}) {
  ensure(30);
  const width = opts.width ?? 250;
  page.drawText(`${label}:`, { x: LEFT, y, size: 10, font, color: BLACK });
  const boxX = LEFT + 246;
  const boxY = y - 4;

  if (form) {
    const field = form.createTextField(opts.name ?? `field_${fieldIndex}`);
    field.setText("");
    field.addToPage(page, {
      x: boxX,
      y: boxY,
      width,
      height: 16,
      borderWidth: 0,
      backgroundColor: rgb(0.97, 0.97, 0.99),
    });
  } else {
    // The underscore run the model must NOT use as its anchor.
    page.drawText("_".repeat(Math.round(width / 4.6)), {
      x: boxX,
      y,
      size: 10,
      font,
      color: GREY,
    });
  }
  fieldIndex += 1;
  y -= 26;
}

function checkbox(label: string, name?: string) {
  ensure(24);
  if (form) {
    const box = form.createCheckBox(name ?? `check_${fieldIndex}`);
    box.addToPage(page, { x: LEFT, y: y - 2, width: 11, height: 11, borderWidth: 0.8 });
  } else {
    page.drawRectangle({
      x: LEFT,
      y: y - 2,
      width: 11,
      height: 11,
      borderWidth: 0.8,
      borderColor: BLACK,
    });
  }
  page.drawText(label, { x: LEFT + 20, y, size: 10, font, color: BLACK });
  fieldIndex += 1;
  y -= 22;
}

function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > max) {
      lines.push(line.trim());
      line = word;
    } else line += ` ${word}`;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

// ── the form ──────────────────────────────────────────────────────────────

heading("Eigenerklärung zur Eignung");
note(
  "Vergabeverfahren: Sanierung der Sanitär- und Heizungsinstallation, " +
    "Grundschule Musterstadt. Vergabenummer VgV-2026-0417. " +
    "Diese Eigenerklärung ist vom Bieter vollständig auszufüllen und rechtsverbindlich zu unterzeichnen.",
);

section("1. Angaben zum Bieter");
field("Name des Unternehmens", { name: "unternehmen_name" });
field("Rechtsform", { name: "rechtsform" });
field("Straße und Hausnummer", { name: "strasse" });
field("PLZ und Ort", { name: "plz_ort" });
field("Telefon", { name: "telefon", width: 180 });
field("E-Mail", { name: "email" });

section("2. Registrierung und Steuern");
field("Handelsregisternummer", { name: "hrb", width: 180 });
field("Registergericht", { name: "registergericht" });
field("Umsatzsteuer-Identifikationsnummer", { name: "ust_id", width: 180 });
field("Steuernummer", { name: "steuernummer", width: 180 });

section("3. Wirtschaftliche Leistungsfähigkeit");
note(
  "Angaben jeweils für die letzten drei abgeschlossenen Geschäftsjahre. " +
    "Der Nachweis ist auf gesondertes Verlangen der Vergabestelle vorzulegen.",
);
field("Jahresumsatz 2025 (EUR, netto)", { name: "umsatz_2025", width: 180 });
field("Jahresumsatz 2024 (EUR, netto)", { name: "umsatz_2024", width: 180 });
field("Anzahl der Beschäftigten (Jahresmittel)", { name: "beschaeftigte", width: 120 });
field("Betriebshaftpflicht Deckungssumme (EUR)", { name: "haftpflicht", width: 180 });

section("4. Fachliche Eignung");
field("Anzahl vergleichbarer Referenzprojekte", { name: "referenzen_anzahl", width: 120 });
field("Größtes Referenzprojekt (Auftragswert EUR)", { name: "referenz_wert", width: 180 });
field("Ansprechpartner für dieses Verfahren", { name: "ansprechpartner" });

section("5. Erklärungen des Bieters");
checkbox("Es liegen keine Ausschlussgründe nach §§ 123, 124 GWB vor.", "keine_ausschluss");
checkbox("Der Mindestlohn nach MiLoG wird gezahlt.", "mindestlohn");
checkbox("Das Unternehmen ist präqualifiziert (PQ-VOB).", "praequalifiziert");
checkbox("Es wird eine Bietergemeinschaft gebildet.", "bietergemeinschaft");

section("6. Unterschrift");
field("Ort, Datum", { name: "ort_datum" });
field("Name des Unterzeichners", { name: "unterzeichner" });
field("Funktion im Unternehmen", { name: "funktion" });
y -= 10;
page.drawLine({
  start: { x: LEFT, y },
  end: { x: LEFT + 240, y },
  thickness: 0.7,
  color: RULE,
});
y -= 12;
page.drawText("Rechtsverbindliche Unterschrift und Firmenstempel", {
  x: LEFT,
  y,
  size: 8.5,
  font,
  color: GREY,
});

const bytes = await doc.save();
const dir = path.join(process.cwd(), "fixtures");
await mkdir(dir, { recursive: true });
const file = path.join(dir, withAcroForm ? "eigenerklaerung-acroform.pdf" : "eigenerklaerung-test.pdf");
await writeFile(file, bytes);
console.log(
  `wrote ${file} — ${bytes.byteLength} bytes, ${doc.getPageCount()} page(s), ` +
    `${fieldIndex} fields (${withAcroForm ? "AcroForm" : "overlay text"})`,
);
