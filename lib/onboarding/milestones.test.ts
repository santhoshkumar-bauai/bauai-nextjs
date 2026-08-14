import { describe, expect, it } from "vitest";

import enMessages from "../../messages/en.json" with { type: "json" };
import {
  MILESTONES,
  MILESTONE_IDS,
  availableMilestones,
  isMilestoneId,
  sanitizePlan,
} from "./milestones.ts";

function lookup(tree: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[key]
          : undefined,
      tree,
    );
}

describe("milestone registry", () => {
  it("declares every id exactly once, keyed by itself", () => {
    for (const id of MILESTONE_IDS) {
      expect(MILESTONES[id].id).toBe(id);
    }
    expect(new Set(MILESTONE_IDS).size).toBe(MILESTONE_IDS.length);
  });

  it("targets only data-tour selectors", () => {
    for (const id of MILESTONE_IDS) {
      for (const step of MILESTONES[id].steps) {
        // Classes and nth-child break on the next restyle, silently.
        expect(step.selector).toMatch(/^\[data-tour="[a-z0-9-]+"\]$/);
      }
    }
  });

  it("gives every milestone at least one step and an absolute route", () => {
    for (const id of MILESTONE_IDS) {
      expect(MILESTONES[id].steps.length).toBeGreaterThan(0);
      expect(MILESTONES[id].route).toMatch(/^\//);
    }
  });

  it("only requires milestones that exist", () => {
    for (const id of MILESTONE_IDS) {
      for (const prerequisite of MILESTONES[id].requires ?? []) {
        expect(MILESTONE_IDS).toContain(prerequisite);
      }
    }
  });

  it("has English copy behind every i18n key it declares", () => {
    for (const id of MILESTONE_IDS) {
      const milestone = MILESTONES[id];
      expect(lookup(enMessages, `Otto.milestones.${milestone.labelKey}`)).toBeTypeOf(
        "string",
      );
      expect(lookup(enMessages, `Otto.milestones.${milestone.bodyKey}`)).toBeTypeOf(
        "string",
      );
      for (const step of milestone.steps) {
        expect(lookup(enMessages, `Otto.steps.${step.copyKey}`)).toBeTypeOf("string");
      }
    }
  });

  it("writes model descriptions substantial enough to choose from", () => {
    for (const id of MILESTONE_IDS) {
      expect(MILESTONES[id].modelDescription.length).toBeGreaterThan(60);
    }
  });
});

describe("isMilestoneId", () => {
  it("accepts registry ids and rejects everything else", () => {
    expect(isMilestoneId("ask_clara")).toBe(true);
    expect(isMilestoneId("invent_a_step")).toBe(false);
    expect(isMilestoneId(null)).toBe(false);
    expect(isMilestoneId(42)).toBe(false);
  });
});

describe("availableMilestones", () => {
  it("hides admin-only milestones from members", () => {
    const ids = availableMilestones({ role: "member", matchEnabled: true }).map(
      (milestone) => milestone.id,
    );
    expect(ids).not.toContain("complete_company_profile");
  });

  it("hides AI matching when the deployment has it switched off", () => {
    const ids = availableMilestones({ role: "admin", matchEnabled: false }).map(
      (milestone) => milestone.id,
    );
    expect(ids).not.toContain("build_ai_matches");
  });
});

describe("sanitizePlan", () => {
  const admin = { role: "admin" as const, matchEnabled: true };

  it("drops ids the model invented", () => {
    expect(
      sanitizePlan({ proposed: ["ask_clara", "become_ceo"], ...admin }),
    ).toEqual(["ask_clara"]);
  });

  it("drops duplicates", () => {
    expect(
      sanitizePlan({ proposed: ["ask_clara", "ask_clara"], ...admin }),
    ).toEqual(["ask_clara"]);
  });

  it("drops milestones the role may not do", () => {
    expect(
      sanitizePlan({
        proposed: ["complete_company_profile", "ask_clara"],
        role: "member",
        matchEnabled: true,
      }),
    ).toEqual(["ask_clara"]);
  });

  it("reorders so a prerequisite comes before its dependant", () => {
    expect(
      sanitizePlan({
        proposed: ["review_pipeline", "save_first_tender"],
        ...admin,
      }),
    ).toEqual(["save_first_tender", "review_pipeline"]);
  });

  it("drops a dependant whose prerequisite was never planned", () => {
    // The user agreed to a plan; quietly inserting an extra step is not the
    // fix for a model that proposed an unreachable one.
    expect(sanitizePlan({ proposed: ["review_pipeline"], ...admin })).toEqual([]);
  });

  it("keeps a legal plan untouched", () => {
    const proposed = ["complete_company_profile", "build_ai_matches", "ask_clara"];
    expect(sanitizePlan({ proposed, ...admin })).toEqual(proposed);
  });

  it("returns nothing for an empty proposal", () => {
    expect(sanitizePlan({ proposed: [], ...admin })).toEqual([]);
  });
});
