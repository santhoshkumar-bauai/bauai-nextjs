import { describe, expect, it } from "vitest";

import { bindWebSearch, citationUrls } from "./web-search.ts";

/** Enough of a BaseChatModel for the binding branch. */
function fakeModel(bindable = true) {
  const bound: unknown[][] = [];
  const model = bindable
    ? { bindTools: (tools: unknown[]) => (bound.push(tools), { invoke: async () => ({}) }) }
    : {};
  return { model: model as never, bound };
}

describe("bindWebSearch", () => {
  it("binds googleSearch on gemini", async () => {
    const { model, bound } = fakeModel();
    expect(await bindWebSearch(model, "gemini")).not.toBeNull();
    expect(bound[0]).toEqual([{ googleSearch: {} }]);
  });

  it("binds the web_search server tool, located in Germany, on azure and openai", async () => {
    for (const provider of ["azure", "openai"]) {
      const { model, bound } = fakeModel();
      expect(await bindWebSearch(model, provider)).not.toBeNull();
      const tool = bound[0][0] as { type?: string; user_location?: { country?: string } };
      expect(tool.type).toBe("web_search");
      // Unlocated searches return US retail; these callers want German prices.
      expect(tool.user_location?.country).toBe("DE");
    }
  });

  it("returns null for a provider with no native search", async () => {
    // Callers degrade to "no web evidence" on null — pricing never blocks.
    expect(await bindWebSearch(fakeModel().model, "anthropic")).toBeNull();
    expect(await bindWebSearch(fakeModel().model, "mistral")).toBeNull();
  });

  it("returns null when the model cannot bind tools at all", async () => {
    expect(await bindWebSearch(fakeModel(false).model, "azure")).toBeNull();
  });
});

describe("citationUrls", () => {
  const withAnnotations = (urls: string[]) => ({
    content: [
      { type: "text", text: "…", annotations: urls.map((url) => ({ type: "url_citation", url })) },
    ],
  });

  it("reads url_citation annotations from the Responses API", () => {
    expect(citationUrls(withAnnotations(["https://a.de/x", "https://b.de/y"]))).toEqual([
      "https://a.de/x",
      "https://b.de/y",
    ]);
  });

  it("dedupes a source that arrives both clean and markdown-wrapped", () => {
    // Observed live: the annotation spans the closing parens of the markdown
    // link the model wrote, so the same shop appears twice and inflates
    // apparent corroboration in the pricing prompt.
    expect(
      citationUrls(withAnnotations(["https://shop.de/zement-25-kg/", "https://shop.de/zement-25-kg/))"])),
    ).toEqual(["https://shop.de/zement-25-kg/"]);
  });

  it("keeps balanced parentheses that belong to the URL", () => {
    const url = "https://de.wikipedia.org/wiki/Zement_(Baustoff)";
    expect(citationUrls(withAnnotations([url]))).toEqual([url]);
  });

  it("strips trailing sentence punctuation", () => {
    expect(citationUrls(withAnnotations(["https://a.de/x.", "https://b.de/y,"]))).toEqual([
      "https://a.de/x",
      "https://b.de/y",
    ]);
  });

  it("falls back to scanning Gemini grounding metadata", () => {
    // No published shape for that payload, hence a scan rather than a path.
    expect(
      citationUrls({
        content: "plain text answer",
        response_metadata: { groundingChunks: [{ web: { uri: "https://g.de/z" } }] },
      }),
    ).toEqual(["https://g.de/z"]);
  });

  it("prefers annotations over the scan when both are present", () => {
    expect(
      citationUrls({
        ...withAnnotations(["https://annotated.de/x"]),
        response_metadata: { junk: "https://metadata.de/y" },
      }),
    ).toEqual(["https://annotated.de/x"]);
  });

  it("returns nothing when the response was not grounded", () => {
    expect(citationUrls({ content: "no search happened" })).toEqual([]);
  });
});
