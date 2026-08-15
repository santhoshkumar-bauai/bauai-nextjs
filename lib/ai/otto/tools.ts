import { tool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { isMilestoneComplete } from "../../onboarding/completion.ts";
import {
  MILESTONES,
  MILESTONE_IDS,
  availableMilestones,
  type MilestoneId,
} from "../../onboarding/milestones.ts";
import type { OttoRunContext } from "./context.ts";

/**
 * Otto's tools. Every one that touches the UI takes a MILESTONE ID and nothing
 * else — no routes, no selectors, no DOM. The registry turns that id into a
 * route and a step list here, server-side, after validating it.
 *
 * The zod enum is built from MILESTONE_IDS, so a hallucinated milestone is
 * rejected by the tool-calling layer before any handler runs. That is the
 * mechanical version of the rule, rather than a line in the prompt asking the
 * model nicely.
 */

const milestoneIdSchema = z.enum(MILESTONE_IDS);

/** Docs Otto may open. Whitelisted: a slug is a URL by another name. */
const HELP_DOC_SLUGS = [
  "getting-started",
  "tender-matching",
  "document-editing",
  "pipeline-basics",
] as const;

export function buildOttoTools(ctx: OttoRunContext): StructuredToolInterface[] {
  /** Shared guard: a milestone this user cannot act on is not navigable. */
  const assertUsable = (milestoneId: MilestoneId): string | null => {
    const usable = availableMilestones({
      role: ctx.onboardingRole,
      matchEnabled: ctx.matchEnabled,
    }).some((milestone) => milestone.id === milestoneId);
    if (usable) return null;
    return JSON.stringify({
      ok: false,
      reason:
        "That milestone does not apply to this user (role or feature availability). " +
        "Pick another from the plan.",
    });
  };

  const navigateToMilestone = tool(
    async ({ milestoneId }) => {
      const blocked = assertUsable(milestoneId);
      if (blocked) return blocked;

      const milestone = MILESTONES[milestoneId];
      const id = ctx.uiCalls.add({
        action: "navigateTo",
        // The ROUTE comes from the registry, never from the model.
        args: { milestoneId, route: milestone.route },
      });
      if (!id) {
        return JSON.stringify({
          ok: false,
          reason: "Too many UI actions this turn. Let the user act before asking again.",
        });
      }
      return JSON.stringify({ ok: true, navigatedTo: milestone.route });
    },
    {
      name: "navigate_to_milestone",
      description:
        "Take the user to the page where a milestone happens. Use this before " +
        "highlighting anything, and only for a milestone in the current plan.",
      schema: z.object({ milestoneId: milestoneIdSchema }),
    },
  );

  const startMilestoneTour = tool(
    async ({ milestoneId }) => {
      const blocked = assertUsable(milestoneId);
      if (blocked) return blocked;

      const milestone = MILESTONES[milestoneId];
      const id = ctx.uiCalls.add({
        action: "startMilestoneTour",
        // Steps are expanded from the registry; the model never sees or sends
        // a selector.
        args: { milestoneId, route: milestone.route },
      });
      if (!id) {
        return JSON.stringify({
          ok: false,
          reason: "Too many UI actions this turn. Let the user act before asking again.",
        });
      }
      return JSON.stringify({ ok: true, steps: milestone.steps.length });
    },
    {
      name: "start_milestone_tour",
      description:
        "Run the guided spotlight for a milestone: navigates if needed, then " +
        "highlights each control in order. Prefer this over navigating and " +
        "highlighting separately.",
      schema: z.object({ milestoneId: milestoneIdSchema }),
    },
  );

  const checkMilestone = tool(
    async ({ milestoneId }) => {
      const complete = await isMilestoneComplete(milestoneId, ctx.milestoneContext);
      return JSON.stringify({ milestoneId, complete });
    },
    {
      name: "check_milestone_complete",
      description:
        "Check against real account data whether a milestone is actually done. " +
        "Use this instead of assuming — you cannot see what the user did.",
      schema: z.object({ milestoneId: milestoneIdSchema }),
    },
  );

  const describeMilestones = tool(
    async () => {
      const usable = availableMilestones({
        role: ctx.onboardingRole,
        matchEnabled: ctx.matchEnabled,
      });
      return JSON.stringify(
        usable.map((milestone) => ({
          id: milestone.id,
          description: milestone.modelDescription,
          requires: milestone.requires ?? [],
        })),
      );
    },
    {
      name: "list_available_milestones",
      description:
        "List the milestones this particular user can do, with what each is for. " +
        "Use when you need to explain the options or re-plan.",
      schema: z.object({}),
    },
  );

  const openHelpDoc = tool(
    async ({ slug }) => {
      const id = ctx.uiCalls.add({ action: "openHelpDoc", args: { slug } });
      if (!id) {
        return JSON.stringify({ ok: false, reason: "Too many UI actions this turn." });
      }
      return JSON.stringify({ ok: true, opened: slug });
    },
    {
      name: "open_help_doc",
      description:
        "Open a help article in the side panel. Only the listed slugs exist.",
      schema: z.object({ slug: z.enum(HELP_DOC_SLUGS) }),
    },
  );

  const seedDemoData = tool(
    async ({ milestoneId }) => {
      const blocked = assertUsable(milestoneId);
      if (blocked) return blocked;

      const id = ctx.uiCalls.add({ action: "seedDemoData", args: { milestoneId } });
      if (!id) {
        return JSON.stringify({ ok: false, reason: "Too many UI actions this turn." });
      }
      // The client asks for confirmation before writing anything, so the most
      // this can truthfully report is that it asked.
      return JSON.stringify({
        ok: true,
        note: "Asked the user to confirm. Wait for their reply; nothing was created yet.",
      });
    },
    {
      name: "seed_demo_data",
      description:
        "Offer to create a sample record so an empty screen is not a dead end. " +
        "The user must confirm first — never describe the data as created.",
      schema: z.object({ milestoneId: milestoneIdSchema }),
    },
  );

  return [
    navigateToMilestone,
    startMilestoneTour,
    checkMilestone,
    describeMilestones,
    openHelpDoc,
    seedDemoData,
  ];
}
