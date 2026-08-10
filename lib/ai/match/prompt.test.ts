import { describe, expect, it } from "vitest";

import { buildMatchJudgePrompt, type JudgeCandidate } from "./prompt.ts";

const candidate = (overrides: Partial<JudgeCandidate> = {}): JudgeCandidate => ({
  ref: 0,
  title: "Neubau FFW Schwarzholz - Los 4 Elektroinstallation",
  buyerName: "Gemeinde Schwarzholz",
  categories: [],
  regions: ["DEE0"],
  submissionDeadline: "2026-09-01",
  estimatedValue: null,
  contractNature: "works",
  procedureType: "open",
  description: "Elektroinstallation für das neue Feuerwehrgerätehaus.",
  ...overrides,
});

describe("buildMatchJudgePrompt", () => {
  it("renders the matched-via line outside the tender fence", () => {
    // The fence marks exactly the third-party text the data boundary covers;
    // retrieval provenance is our metadata and must not sit inside it.
    const prompt = buildMatchJudgePrompt({
      companyContext: "## Capabilities\nServices: Elektroinstallation",
      candidates: [
        candidate({ matchedVia: ["uploaded document: Turnhalle.docx"] }),
      ],
    });
    const fenceStart = prompt.indexOf('<tender ref="0">');
    const matchedVia = prompt.indexOf(
      "Matched via: uploaded document: Turnhalle.docx",
    );
    expect(matchedVia).toBeGreaterThan(-1);
    expect(matchedVia).toBeLessThan(fenceStart);
  });

  it("omits the matched-via line when there is no provenance", () => {
    const prompt = buildMatchJudgePrompt({
      companyContext: "ctx",
      candidates: [candidate()],
    });
    expect(prompt).not.toContain("Matched via:");
  });

  it("tells the judge that matched-via is context, not evidence", () => {
    const prompt = buildMatchJudgePrompt({
      companyContext: "ctx",
      candidates: [candidate()],
    });
    expect(prompt).toContain("It is context, not evidence");
    expect(prompt).toContain("CPV codes on notices are frequently wrong or missing");
  });

  it("joins several provenance labels on one line", () => {
    const prompt = buildMatchJudgePrompt({
      companyContext: "ctx",
      candidates: [
        candidate({
          matchedVia: ["company capabilities", "notice text matches your services"],
        }),
      ],
    });
    expect(prompt).toContain(
      "Matched via: company capabilities; notice text matches your services",
    );
  });
});
