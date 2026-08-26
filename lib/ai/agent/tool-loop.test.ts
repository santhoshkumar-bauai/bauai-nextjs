import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  approxMessageTokens,
  sanitizeToolPairs,
  toolLoopRecursionLimit,
  windowFromUserTurn,
} from "./tool-loop.ts";

const human = (text: string) => new HumanMessage(text);
const ai = (text: string) => new AIMessage(text);
const aiCalling = (name: string, id: string) =>
  new AIMessage({ content: "", tool_calls: [{ name, args: {}, id, type: "tool_call" }] });
const toolReply = (id: string, text = "{}") =>
  new ToolMessage({ content: text, tool_call_id: id });

describe("approxMessageTokens", () => {
  it("charges text roughly by length", () => {
    const short = approxMessageTokens([human("hi")]);
    const long = approxMessageTokens([human("x".repeat(3_500))]);
    expect(long).toBeGreaterThan(short * 50);
  });

  it("charges images and files instead of scoring them zero", () => {
    // This is the whole reason for a local counter. LangChain's own
    // `getNumTokens` sums only text blocks, so a window of 50 rendered pages
    // would measure as nothing and never trim — precisely the window that
    // needs trimming.
    const withImage = new HumanMessage({
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ] as never,
    });
    expect(approxMessageTokens([withImage])).toBeGreaterThan(500);
  });

  it("charges a media_ref by what it will cost once materialized", () => {
    // Trimming runs before resolveMediaParts, so attachments are still refs.
    const ref = new HumanMessage({
      content: [
        { type: "media_ref", mimeType: "application/pdf", key: "s3://x" },
      ] as never,
    });
    expect(approxMessageTokens([ref])).toBeGreaterThan(1_000);
  });

  it("charges tool calls, which serialize into the request", () => {
    expect(approxMessageTokens([aiCalling("search_tender_documents", "c1")])).toBeGreaterThan(
      approxMessageTokens([ai("")]),
    );
  });
});

describe("sanitizeToolPairs", () => {
  it("drops a dangling tool-call turn left by the finalize path", () => {
    // A concat reducer can only append, so the finalize path leaves the
    // model's unanswered tool-call request in checkpointed state. Gemini hard
    // rejects a function-call turn with no responses after it.
    const kept = sanitizeToolPairs([human("q"), aiCalling("t", "c1")]);
    expect(kept.map((m) => m.getType())).toEqual(["human"]);
  });

  it("keeps an intact call/response pair", () => {
    const kept = sanitizeToolPairs([human("q"), aiCalling("t", "c1"), toolReply("c1"), ai("a")]);
    expect(kept).toHaveLength(4);
  });

  it("drops an orphan tool response with no calling turn", () => {
    const kept = sanitizeToolPairs([human("q"), toolReply("c1"), ai("a")]);
    expect(kept.map((m) => m.getType())).toEqual(["human", "ai"]);
  });
});

describe("windowFromUserTurn", () => {
  it("opens the window on a user turn, never mid tool-loop", () => {
    // A window opening on a function-call turn is a guaranteed Gemini 400:
    // such a turn must follow a user turn or a function response.
    const messages = [
      human("first"),
      aiCalling("t", "c1"),
      toolReply("c1"),
      ai("answer"),
      human("second"),
      aiCalling("t", "c2"),
      toolReply("c2"),
      ai("answer 2"),
    ];
    expect(windowFromUserTurn(messages, 4)[0].getType()).toBe("human");
  });

  it("overshoots rather than returning a window that would 400", () => {
    // "A window slightly over max beats a guaranteed 400."
    const messages = [human("only user turn"), aiCalling("t", "c1"), toolReply("c1"), ai("a")];
    expect(windowFromUserTurn(messages, 2)[0].getType()).toBe("human");
  });
});

describe("toolLoopRecursionLimit", () => {
  it("exceeds the worst-case superstep count", () => {
    for (const iterations of [1, 8, 10, 20]) {
      expect(toolLoopRecursionLimit(iterations)).toBeGreaterThan(2 * iterations + 2);
    }
  });
});
