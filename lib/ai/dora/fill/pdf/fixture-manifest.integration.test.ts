import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildPdfManifest } from "./manifest.ts";
import { shouldSendPdfNatively } from "./model-input.ts";

/**
 * The generated test forms (`npm run test:pdf`) must actually be analyzable —
 * a fixture the manifest cannot read would make every downstream failure look
 * like a model problem.
 */
describe("test fixture manifests", () => {
  for (const [file, expectAcro] of [
    ["eigenerklaerung-test.pdf", false],
    ["eigenerklaerung-acroform.pdf", true],
  ] as const) {
    it(`reads ${file}`, async () => {
      const bytes = await readFile(path.join(process.cwd(), "fixtures", file));
      const manifest = await buildPdfManifest(bytes);
      const native = shouldSendPdfNatively({
        bytes: bytes.byteLength,
        documentClass: manifest.classification.documentClass,
      });
      console.log(
        `[${file}] class=${manifest.classification.documentClass} ` +
          `acroFields=${manifest.acroFields.length} lines=${manifest.lines.length} native=${native}`,
      );
      console.log(
        `  labels: ${manifest.lines.slice(0, 6).map((l) => l.text.slice(0, 30)).join(" | ")}`,
      );
      if (manifest.acroFields.length > 0) {
        console.log(
          `  acro: ${manifest.acroFields.slice(0, 8).map((a) => a.fieldName).join(", ")}`,
        );
      }

      // Never a scan: a scanned class sends every field down the vision path
      // and the overlay anchoring is never exercised at all.
      expect(manifest.classification.documentClass).toBe(expectAcro ? "acroform" : "digital");
      expect(manifest.lines.length).toBeGreaterThan(10);
      if (expectAcro) expect(manifest.acroFields.length).toBeGreaterThan(10);
      else expect(manifest.acroFields).toHaveLength(0);

      // The labels the analyzer anchors to must survive extraction, umlauts
      // and all — "Handelsregisternummer" is the one a broken encoding eats.
      const text = manifest.lines.map((l) => l.text).join(" ");
      expect(text).toMatch(/Handelsregisternummer/);
      expect(text).toMatch(/Umsatzsteuer/);
      expect(text).toMatch(/Jahresumsatz/);
    });
  }
});
