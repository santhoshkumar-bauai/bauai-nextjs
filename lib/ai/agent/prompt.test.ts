import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";

import { CitationCollector } from "./citations.ts";
import type { AgentRunContext } from "./context.ts";
import { buildClaraSystemPrompt } from "./prompt.ts";

function ctxOf(tender: AgentRunContext["tender"]): AgentRunContext {
  return {
    tenantId: new ObjectId(),
    userId: "u",
    locale: "en",
    companyContext: {} as never,
    citations: new CitationCollector(),
    tender,
    tenderCache: new Map(),
  };
}

const tenderCtx = ctxOf({
  tenderId: new ObjectId(),
  tenderDetail: {
    title: "Neubau Kita",
    status: "OPEN",
    buyer: { name: "Stadt X" },
    submissionDeadline: "2026-09-01",
  } as never,
});

describe("buildClaraSystemPrompt", () => {
  // The persona name is the product brand; a half-finished rebrand should fail
  // here rather than reach a user mid-conversation.
  it("both modes introduce the agent as Clara", () => {
    expect(buildClaraSystemPrompt(tenderCtx)).toContain("You are Clara,");
    expect(buildClaraSystemPrompt(ctxOf(null))).toContain("You are Clara,");
  });

  it("tender mode carries the current-tender block, global mode the scope block", () => {
    const tenderPrompt = buildClaraSystemPrompt(tenderCtx);
    expect(tenderPrompt).toContain("## Current tender");
    expect(tenderPrompt).toContain("Neubau Kita");
    expect(tenderPrompt).not.toContain("find_tenders");

    const globalPrompt = buildClaraSystemPrompt(ctxOf(null));
    expect(globalPrompt).toContain("## Scope");
    expect(globalPrompt).toContain("find_tenders");
    expect(globalPrompt).not.toContain("## Current tender");
  });

  it("citation and data-boundary rules are byte-identical in both modes", () => {
    const tail = (prompt: string) =>
      prompt.slice(prompt.indexOf("## How to answer"));
    expect(tail(buildClaraSystemPrompt(tenderCtx))).toBe(
      tail(buildClaraSystemPrompt(ctxOf(null))),
    );
  });
});
