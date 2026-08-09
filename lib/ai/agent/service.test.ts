import { describe, expect, it } from "vitest";

import { textFromContent } from "./service.ts";

describe("textFromContent", () => {
  it("passes plain strings through", () => {
    expect(textFromContent("hello")).toBe("hello");
  });

  // gemini-3.5-flash (thinking model) returns parts arrays; dropping them
  // rendered finished answers as empty "Stopped" bubbles — regression guard.
  it("joins text parts and drops reasoning parts from arrays", () => {
    expect(
      textFromContent([
        { type: "reasoning", reasoning: "internal chain of thought" },
        { type: "text", text: "The deadline is " },
        "2 November 2026.",
        { type: "text", text: " Submit early." },
      ]),
    ).toBe("The deadline is 2 November 2026. Submit early.");
  });

  it("returns empty for tool-call-only or unknown content", () => {
    expect(textFromContent(undefined)).toBe("");
    expect(textFromContent(null)).toBe("");
    expect(textFromContent({ some: "object" })).toBe("");
    expect(textFromContent([{ type: "tool_use", id: "x" }])).toBe("");
  });
});
