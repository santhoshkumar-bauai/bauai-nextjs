import { getChatModel } from "@/lib/ai/agent/model";
import { aiEnv } from "@/lib/ai/config/env";
import { resolveRole } from "../../../gateway/config.ts";
import { bindWebSearch, citationUrls } from "../../../agent/web-search.ts";

import { GAEB_WEB_PRICE_JSON_SCHEMA, gaebWebPriceSchema } from "./schema-gaeb";
import { withProviderStructuredOutput } from "../../../agent/structured.ts";

/**
 * Search-grounded market-price evidence for named products. Strictly an
 * evidence provider: failures, unsupported providers, or the kill switch all
 * degrade to "no web evidence" plus a run warning — pricing itself never
 * blocks on the web.
 *
 * Two steps, and they stay two steps.
 *
 * The original reason was a Gemini limitation — grounding could not be
 * combined with forced function calling in one request — and on the Responses
 * API that is no longer true. The reasons that hold now are better ones:
 *
 *   1. Economics. Research is per-product (up to gaebWebPricingMaxLookups);
 *      distillation is batched. Merging turns ~4 structured calls into ~40.
 *   2. Role separation. Research runs on `dora_gaeb_web`; distillation runs on
 *      `dora_gaeb_fill`, the role pinned precisely so that chat-model changes
 *      cannot alter priced offers. Merging puts a searching model inside the
 *      pricing path.
 *   3. Partial-failure isolation. A failed distillation still leaves the
 *      grounded text; a merged call loses both.
 */

export interface GaebWebPriceFinding {
  product: string;
  unitPrice: number | null;
  unit: string;
  currency: string;
  sourceUrl: string;
  sourceTitle: string;
  note: string;
}

const RESEARCH_BATCH = 10;

function textFrom(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof (part as { text?: unknown }).text === "string"
            ? String((part as { text: string }).text)
            : "",
      )
      .join("");
  }
  return "";
}

export async function lookupWebPrices(input: {
  products: string[];
  region: string | null;
  shouldContinue?: () => Promise<boolean>;
  onProgress?: (done: number, total: number) => Promise<void>;
}): Promise<{ findings: GaebWebPriceFinding[]; warnings: string[] }> {
  const env = aiEnv();
  const warnings: string[] = [];
  if (!env.gaebWebPricingEnabled || input.products.length === 0) {
    return { findings: [], warnings };
  }

  const products = input.products.slice(0, env.gaebWebPricingMaxLookups);

  let grounded: { product: string; text: string; urls: string[] }[] = [];
  try {
    const model = await getChatModel({
      role: "dora_gaeb_web",
      // No explicit budget: the role table sizes it. 2048 was safe when the
      // response was only search results; a reasoning model bills its
      // thinking from the same allowance and would return empty text —
      // which this stage is designed to swallow as "no evidence".
      reasoningEffort: "low",
    });
    // Native web search — genuinely provider-specific, so the branch lives in
    // one helper. null means this provider cannot search, and the catch below
    // degrades the stage to "no web evidence".
    const searching = await bindWebSearch(model, resolveRole("dora_gaeb_web").provider);
    if (!searching) throw new Error("web_search_unsupported_provider");

    let done = 0;
    for (const product of products) {
      if (input.shouldContinue && !(await input.shouldContinue())) break;
      try {
        const response = await searching.invoke(
          [
            `Research the current purchase price (net, EUR) of this construction product in Germany${input.region ? ` (region: ${input.region})` : ""}:`,
            `"${product}"`,
            "Report the price per common sales unit, the source, and how recent it is. If no reliable price is findable, say so plainly.",
          ].join("\n"),
        );
        grounded.push({
          product,
          text: textFrom(response.content).slice(0, 2_000),
          urls: citationUrls(response),
        });
      } catch (error) {
        warnings.push(
          `web_lookup_failed:${product.slice(0, 60)}:${error instanceof Error ? error.message.slice(0, 80) : "error"}`,
        );
      }
      done += 1;
      if (input.onProgress) await input.onProgress(done, products.length);
    }
  } catch (error) {
    warnings.push(
      `web_search_unavailable:${error instanceof Error ? error.message.slice(0, 120) : "error"}`,
    );
    grounded = [];
  }

  if (grounded.length === 0) return { findings: [], warnings };

  // Step 2: distill the grounded texts into structured findings.
  const findings: GaebWebPriceFinding[] = [];
  try {
    const extractor = await getChatModel({
      role: "dora_gaeb_fill",
      maxOutputTokens: 4_096,
      temperature: 0,
    });
    const structured = withProviderStructuredOutput(extractor, GAEB_WEB_PRICE_JSON_SCHEMA, {
      name: "gaeb_web_price_findings",
      role: "dora_gaeb_fill",
    });
    for (let index = 0; index < grounded.length; index += RESEARCH_BATCH) {
      const slice = grounded.slice(index, index + RESEARCH_BATCH);
      const raw = await structured.invoke(
        [
          "Extract product price findings from these research notes. One finding per product; unitPrice null when the notes state no reliable price. Copy the most authoritative source URL into sourceUrl.",
          "",
          ...slice.map(
            (entry) =>
              `PRODUCT: ${entry.product}\nSOURCE URLS: ${entry.urls.join(" ") || "(none)"}\nNOTES: ${entry.text}\n`,
          ),
        ].join("\n"),
      );
      const parsed = gaebWebPriceSchema.parse(raw);
      findings.push(...parsed.findings);
    }
  } catch (error) {
    warnings.push(
      `web_extraction_failed:${error instanceof Error ? error.message.slice(0, 120) : "error"}`,
    );
  }

  return { findings, warnings };
}
