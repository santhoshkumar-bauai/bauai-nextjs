import type { GaebDocument, GaebItem } from "@/lib/gaeb/types";

import type { GaebTenderContext } from "../types";
import type { GaebFillClassification } from "./items";
import type { GaebWebPriceFinding } from "./web-prices";

/**
 * Prompt builders for the GAEB fill engine. The whole file is strings-in,
 * string-out so prompt-shape tests need no infrastructure.
 */

const LONG_TEXT_PROMPT_CHARS = 700;

export function buildGaebContextPrompt(input: {
  document: GaebDocument;
  locale: "en" | "de";
}): string {
  const { document } = input;
  const outline = document.categories
    .filter((category) => category.depth <= 1)
    .slice(0, 60)
    .map((category) => `${"  ".repeat(category.depth)}${category.oz} ${category.label}`)
    .join("\n");

  return [
    "You extract the global pricing context of a German construction tender from its bill of quantities (Leistungsverzeichnis).",
    "Only state what the text supports; use null when the document does not say.",
    `Write summary, siteConditions and riskFactors in ${input.locale === "de" ? "German" : "English"}.`,
    "",
    `PROJECT: ${document.meta.projectName ?? "(unknown)"}`,
    `BOQ: ${document.meta.boqName ?? "(unknown)"} — phase X${document.phase}, ${document.stats.itemCount} positions`,
    `BUYER: ${document.meta.buyer?.name ?? "(unknown)"}${document.meta.buyer?.city ? `, ${document.meta.buyer.zip ?? ""} ${document.meta.buyer.city}` : ""}`,
    `CURRENCY: ${document.meta.currency ?? "EUR"} · VAT: ${document.meta.vatRate ?? "(unknown)"}`,
    "",
    `CATEGORY OUTLINE:\n${outline || "(none)"}`,
    "",
    `PRELIMINARY REMARKS (Vorbemerkungen):\n${document.preliminaryText ?? "(none)"}`,
  ].join("\n");
}

function itemLine(item: GaebItem): string {
  const markers = item.markers.length ? ` [${item.markers.join(",")}]` : "";
  const longText = item.longText
    ? item.longText.slice(0, LONG_TEXT_PROMPT_CHARS).replace(/\n+/g, " ")
    : "";
  return [
    `- itemKey=${item.key} oz=${item.oz} qty=${item.qty ?? "?"} ${item.qtyUnit ?? "?"}${markers}`,
    `  short: ${item.shortText}`,
    longText ? `  full: ${longText}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildGaebClassifyPrompt(input: {
  context: GaebTenderContext | null;
  categoryPathByItem: ReadonlyMap<string, string>;
  batch: GaebItem[];
}): string {
  const lines = input.batch
    .map((item) => {
      const path = input.categoryPathByItem.get(item.key);
      return `${itemLine(item)}${path ? `\n  section: ${path}` : ""}`;
    })
    .join("\n");

  return [
    "You classify positions of a German construction bill of quantities for pricing.",
    "For every position return: trade (e.g. sanitary, heating, ventilation, electrical, drywall, demolition), workCategory (the activity, e.g. pipe_demolition, pipe_installation, equipment_supply), up to 8 short technical attributes (dimensions, materials, constraints — copy facts, do not infer), and productMentions: exact manufacturer/product names written in the text (e.g. \"Geberit Mapress DN20\", \"Loxone Miniserver\"). Leave productMentions empty when no product is named.",
    "Return one entry per itemKey, exactly the keys given. Never invent keys.",
    "",
    input.context ? `TENDER CONTEXT: ${input.context.summary}` : null,
    "",
    `POSITIONS:\n${lines}`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function buildGaebPricingPrompt(input: {
  context: GaebTenderContext | null;
  currency: string;
  locale: "en" | "de";
  profileLines: string[];
  batch: Array<{ item: GaebItem; classification: GaebFillClassification | null }>;
  webFindings: GaebWebPriceFinding[];
  comparableLines: string[];
}): string {
  const lines = input.batch
    .map(({ item, classification }) => {
      const cls = classification
        ? `  classified: ${classification.trade}/${classification.workCategory} ${classification.attributes.join("; ")}`
        : null;
      return [itemLine(item), cls].filter(Boolean).join("\n");
    })
    .join("\n");

  const webLines = input.webFindings
    .map(
      (finding) =>
        `web:${finding.sourceUrl || finding.product} — ${finding.product}: ${
          finding.unitPrice !== null ? `${finding.unitPrice} ${finding.currency}/${finding.unit || "unit"}` : "no price found"
        }${finding.note ? ` (${finding.note})` : ""}`,
    )
    .join("\n");

  const language = input.locale === "de" ? "German" : "English";

  return [
    `You are a construction cost estimator drafting unit prices (${input.currency}, net, per source unit) for a German tender.`,
    "",
    "RULES",
    "- Estimate the FULL unit rate a bidder would offer: labor, material, equipment, overhead and margin for the described work under the given tender conditions.",
    "- Ground estimates in the evidence provided (market prices, company data). Where evidence is thin, still estimate from the work description, lower the confidence, and state the assumptions.",
    "- unitPrice null ONLY when the position cannot be priced per unit at all (e.g. text-only placeholder).",
    "- rangeLow <= unitPrice <= rangeHigh. Ranges reflect genuine uncertainty, not decoration.",
    "- confidence in [0,1]: 0.9+ only with strong direct evidence; 0.5 or lower for rough estimates.",
    "- evidenceReferences: cite ONLY keys shown in the evidence sections (company.* keys, chunk:* keys, web:* keys). Never fabricate references.",
    `- Write assumptions, risks and reason in ${language}, brief and concrete.`,
    "- Quantities and totals are computed by software — never mention or compute totals.",
    "- Return one entry per itemKey, exactly the keys given.",
    "",
    input.context
      ? [
          `TENDER CONTEXT: ${input.context.summary}`,
          input.context.siteConditions.length
            ? `SITE CONDITIONS: ${input.context.siteConditions.join("; ")}`
            : null,
          input.context.riskFactors.length
            ? `RISK FACTORS: ${input.context.riskFactors
                .map((risk) => `${risk.factor} (${risk.pricingImpact})`)
                .join("; ")}`
            : null,
        ]
          .filter(Boolean)
          .join("\n")
      : "TENDER CONTEXT: (none)",
    "",
    `COMPANY PROFILE:\n${input.profileLines.join("\n") || "(none)"}`,
    `CURRENT MARKET PRICES (web):\n${webLines || "(none)"}`,
    `COMPARABLE HISTORICAL PRICES:\n${input.comparableLines.join("\n") || "(none)"}`,
    "",
    `POSITIONS TO PRICE:\n${lines}`,
  ].join("\n");
}
