import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Runnable } from "@langchain/core/runnables";

/**
 * Native web search, per provider.
 *
 * The one genuinely provider-specific capability in the agent layer. Gemini
 * exposes `googleSearch` grounding; OpenAI and Azure expose a `web_search`
 * server-side tool on the Responses API. Neither is expressible in the other's
 * vocabulary, so this is a real branch rather than an abstraction.
 *
 * Returns `null` when the configured provider cannot search, which callers
 * must degrade on — GAEB pricing treats web evidence as strictly optional and
 * falls back to "no web evidence" plus a run warning.
 */
export async function bindWebSearch(
  model: BaseChatModel,
  provider: string,
): Promise<Runnable | null> {
  if (!model.bindTools) return null;

  if (provider === "gemini") {
    return model.bindTools([{ googleSearch: {} } as never]);
  }

  if (provider === "azure" || provider === "openai") {
    // Dynamically imported, like the model factory's provider bindings, so a
    // Gemini-only deployment never pulls the OpenAI SDK into its bundle.
    //
    // A built-in tool, which forces the Responses API on its own
    // (`isBuiltInTool` in @langchain/openai) — the only surface where this
    // tool exists. Locating the search in Germany matters: the callers want
    // German market prices, and an unlocated search returns US retail.
    const { tools } = await import("@langchain/openai");
    return model.bindTools([
      tools.webSearch({ userLocation: { type: "approximate", country: "DE" } }) as never,
    ]);
  }

  return null;
}

/**
 * Source URLs from a grounded response, whichever provider produced it.
 *
 * Gemini reports grounding in `response_metadata`, with no stable published
 * shape — hence the scan. The Responses API instead attaches `url_citation`
 * annotations to the content blocks. Reading only the former would leave the
 * evidence chain silently empty on Azure while still "succeeding", which is
 * worse than failing.
 */
export function citationUrls(response: {
  content?: unknown;
  response_metadata?: unknown;
}): string[] {
  const urls = new Set<string>();
  const add = (url: unknown) => {
    if (typeof url !== "string") return;
    const cleaned = trimUrlPunctuation(url);
    if (cleaned) urls.add(cleaned);
  };

  // Responses API: url_citation annotations on text blocks.
  if (Array.isArray(response.content)) {
    for (const part of response.content as unknown[]) {
      const block = part as { annotations?: unknown };
      if (!Array.isArray(block?.annotations)) continue;
      for (const annotation of block.annotations as unknown[]) {
        const cited = annotation as { type?: string; url?: string };
        if (cited?.type === "url_citation") add(cited.url);
      }
    }
  }

  // Gemini grounding metadata: scan, because the shape is not contractual.
  if (urls.size === 0 && response.response_metadata) {
    const found = JSON.stringify(response.response_metadata).match(/https?:\/\/[^"'\\\s]+/g);
    for (const url of found ?? []) add(url);
  }

  return [...urls].slice(0, 8);
}

/**
 * Strip trailing markdown punctuation from a cited URL.
 *
 * Observed live: the same source arrives twice, once clean and once as
 * `…/portlandzement-25-kg/))`, because the annotation spans the closing
 * parens of the markdown link the model wrote around it. Without this the set
 * dedupes to nothing and both variants reach the pricing prompt as separate
 * "sources", inflating apparent corroboration.
 *
 * Only unbalanced closers are removed, so a URL that legitimately contains
 * parentheses (Wikipedia titles, for one) survives intact.
 */
function trimUrlPunctuation(url: string): string {
  let out = url.trim();
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last === "." || last === "," || last === ";" || last === "]" || last === ">") {
      out = out.slice(0, -1);
      continue;
    }
    if (last === ")") {
      const opens = (out.match(/\(/g) ?? []).length;
      const closes = (out.match(/\)/g) ?? []).length;
      if (closes > opens) {
        out = out.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return out;
}
