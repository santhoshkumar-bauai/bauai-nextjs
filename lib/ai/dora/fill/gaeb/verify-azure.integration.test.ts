import { describe, expect, it } from "vitest";

import { getChatModel } from "../../../agent/model.ts";
import { withProviderStructuredOutput } from "../../../agent/structured.ts";
import { aiEnv, roleMaxOutputTokens, roleReasoningEffort } from "../../../config/env.ts";
import { resolveRole } from "../../../gateway/config.ts";
import type { GaebItem } from "@/lib/gaeb/types";
import type { GaebTenderContext } from "../types";
import { buildGaebClassifyPrompt, buildGaebPricingPrompt } from "./prompt-gaeb.ts";
import {
  GAEB_CLASSIFY_BATCH_JSON_SCHEMA,
  GAEB_PRICING_BATCH_JSON_SCHEMA,
  gaebClassifyBatchSchema,
  gaebPricingBatchSchema,
} from "./schema-gaeb.ts";

/**
 * GAEB classify + pricing against the live provider (`AI_INTEGRATION=1`).
 *
 * Synthetic positions rather than a parsed X8x file, deliberately: the parser
 * is deterministic and unrelated to the provider, while these two structured
 * calls are exactly what the Azure migration changed — a hand-written schema
 * that used OpenAPI `nullable` and a partial `required`, both of which strict
 * mode rejects until the adapter rewrites them.
 *
 * The positions are real German LV text (sanitary/heating refurbishment)
 * because the classifier's job includes pulling manufacturer names out of
 * `longText`, and that only works against prose that actually contains them.
 */
const RUN = process.env.AI_INTEGRATION === "1";

function position(
  index: number,
  oz: string,
  shortText: string,
  longText: string,
  qty: number,
  qtyUnit: string,
): GaebItem {
  return {
    key: `i-${String(index).padStart(4, "0")}`,
    sourceIndex: index,
    sourceId: null,
    rNoPart: oz,
    oz,
    categoryKey: "c-01",
    shortText,
    longText,
    longTextTruncated: false,
    qty,
    qtyUnit,
    markers: [],
    existingUnitPrice: null,
    existingTotal: null,
    alternative: null,
    notInTotal: false,
  };
}

const BATCH: GaebItem[] = [
  position(1, "01.01.0010", "Abbruch Trinkwasserleitung DN20-DN50",
    "Demontage und Entsorgung vorhandener verzinkter Trinkwasserleitungen DN20 bis DN50 einschliesslich Daemmung, Befestigungen und Entsorgungsnachweis.", 180, "m"),
  position(2, "01.02.0020", "Trinkwasserleitung Edelstahl Geberit Mapress DN20",
    "Liefern und montieren Trinkwasserleitung aus Edelstahl, Pressverbindung, Fabrikat Geberit Mapress DN20, inkl. Formteile und Befestigungsmaterial.", 210, "m"),
  position(3, "01.03.0030", "Waschtisch mit Armatur montieren",
    "Liefern und montieren Waschtisch 600 mm, Keramik weiss, inkl. Einhebelmischer Grohe Eurosmart und Geruchsverschluss.", 24, "St"),
  position(4, "02.01.0010", "Heizkoerper Typ 22 austauschen",
    "Demontage Altheizkoerper und Montage Kompaktheizkoerper Typ 22, 600x1000 mm, inkl. Thermostatventil.", 36, "St"),
  position(5, "02.02.0040", "Rohrdaemmung 100% nach GEG",
    "Daemmung der Heizungsleitungen nach GEG Anforderung, Mineralwolle, Dicke entsprechend Rohrdurchmesser.", 320, "m"),
];

const CONTEXT: GaebTenderContext = {
  projectType: ["Sanierung", "Sanitaerinstallation", "Heizungsinstallation"],
  building: "Schulgebaeude, Baujahr 1974, 3 Geschosse",
  existingBuilding: true,
  occupiedDuringConstruction: true,
  region: "Berlin-Mitte",
  siteConditions: [
    "Arbeiten im laufenden Schulbetrieb",
    "Beengte Schachtverhaeltnisse",
  ],
  riskFactors: [
    { factor: "Bauen im Bestand mit unbekannter Leitungsfuehrung", pricingImpact: "high" },
    { factor: "Arbeiten nur in den Schulferien moeglich", pricingImpact: "medium" },
  ],
  summary:
    "Sanierung Sanitaer- und Heizungsinstallation, Schulgebaeude Berlin-Mitte, Ausfuehrung 2027 im laufenden Betrieb.",
};

describe.skipIf(!RUN)("gaeb fill (live)", () => {
  it("classifies positions and drafts unit prices", async () => {
    const env = aiEnv();
    const ref = resolveRole("dora_gaeb_fill");
    console.log(
      `[gaeb] role → ${ref.provider}:${ref.model} ` +
        `effort=${roleReasoningEffort("dora_gaeb_fill")} maxOut=${roleMaxOutputTokens("dora_gaeb_fill")}`,
    );

    const model = await getChatModel({
      role: "dora_gaeb_fill",
      maxOutputTokens: env.gaebFillMaxOutputTokens,
      temperature: 0,
    });

    // ── classify ────────────────────────────────────────────────────────
    const categoryPathByItem = new Map(
      BATCH.map((item) => [item.key, "Titel 01 — Sanitaerinstallation"]),
    );
    const classify = withProviderStructuredOutput(model, GAEB_CLASSIFY_BATCH_JSON_SCHEMA, {
      role: "dora_gaeb_fill",
      name: "gaeb_classify_batch",
    });
    const classified = gaebClassifyBatchSchema.parse(
      await classify.invoke(
        buildGaebClassifyPrompt({ context: CONTEXT, categoryPathByItem, batch: BATCH }),
      ),
    );
    for (const item of classified.items) {
      console.log(
        `  ${item.itemKey} ${item.trade.padEnd(10)} ${item.workCategory.padEnd(24)} ` +
          `products=${JSON.stringify(item.productMentions)}`,
      );
    }

    expect(classified.items).toHaveLength(BATCH.length);
    // Keys are the join back to the price sheet; an invented one is unusable.
    expect(classified.items.map((i) => i.itemKey).sort()).toEqual(BATCH.map((i) => i.key).sort());
    // productMentions feeds the web-price lookups, so a named manufacturer in
    // the long text has to survive into it.
    const mapress = classified.items.find((i) => i.itemKey === "i-0002");
    expect(mapress?.productMentions.join(" ")).toMatch(/Geberit|Mapress/i);
    // Nothing is named in the demolition position; inventing one would send
    // the web stage chasing a product that does not exist.
    expect(classified.items.find((i) => i.itemKey === "i-0001")?.productMentions).toEqual([]);

    // ── pricing ─────────────────────────────────────────────────────────
    const byKey = new Map(classified.items.map((item) => [item.itemKey, item]));
    const pricing = withProviderStructuredOutput(model, GAEB_PRICING_BATCH_JSON_SCHEMA, {
      role: "dora_gaeb_fill",
      name: "gaeb_pricing_batch",
    });
    const priced = gaebPricingBatchSchema.parse(
      await pricing.invoke(
        buildGaebPricingPrompt({
          context: CONTEXT,
          currency: "EUR",
          locale: "de",
          profileLines: [
            "Company: Wirl Ing GmbH, Berlin",
            "Trades: Sanitaer, Heizung, Tiefbau",
            "Typical project size: 200k-2M EUR",
          ],
          batch: BATCH.map((item) => ({ item, classification: byKey.get(item.key) ?? null })),
          webFindings: [
            {
              product: "Geberit Mapress DN20",
              unitPrice: 12.4,
              unit: "m",
              currency: "EUR",
              sourceUrl: "https://example-baustoffe.de/mapress",
              sourceTitle: "Baustoffe",
              note: "Listenpreis netto",
            },
          ],
          comparableLines: [],
        }),
      ),
    );
    for (const item of priced.items) {
      console.log(`  ${item.itemKey} unitPrice=${String(item.unitPrice).padStart(8)} EUR conf=${item.confidence}`);
    }

    expect(priced.items).toHaveLength(BATCH.length);
    for (const item of priced.items) {
      // unitPrice is nullable BY DESIGN — the estimator may decline. What must
      // never happen is a negative or absurd number reaching a priced offer.
      if (item.unitPrice !== null) {
        expect(item.unitPrice).toBeGreaterThan(0);
        expect(item.unitPrice).toBeLessThan(100_000);
      }
      expect(item.confidence).toBeGreaterThanOrEqual(0);
      expect(item.confidence).toBeLessThanOrEqual(1);
    }
  }, 300_000);
});
