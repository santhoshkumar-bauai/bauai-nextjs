import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";

import { CitationCollector } from "./citations.ts";
import type { AgentRunContext } from "./context.ts";
import { buildDoraSystemPrompt } from "./prompt.ts";

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

describe("buildDoraSystemPrompt", () => {
  it("tender mode carries the current-tender block, global mode the scope block", () => {
    const tenderPrompt = buildDoraSystemPrompt(tenderCtx);
    expect(tenderPrompt).toContain("## Current tender");
    expect(tenderPrompt).toContain("Neubau Kita");
    expect(tenderPrompt).not.toContain("find_tenders");

    const globalPrompt = buildDoraSystemPrompt(ctxOf(null));
    expect(globalPrompt).toContain("## Scope");
    expect(globalPrompt).toContain("find_tenders");
    expect(globalPrompt).not.toContain("## Current tender");
  });

  it("citation and data-boundary rules are byte-identical in both modes", () => {
    const tail = (prompt: string) =>
      prompt.slice(prompt.indexOf("## How to answer"));
    expect(tail(buildDoraSystemPrompt(tenderCtx))).toBe(
      tail(buildDoraSystemPrompt(ctxOf(null))),
    );
  });
});
