"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { z } from "zod";

import { useAgentAction, useAgentReadable } from "@/components/agent/agent-actions";
import {
  MILESTONES,
  MILESTONE_IDS,
  MILESTONE_ROUTES,
  type MilestoneId,
} from "@/lib/onboarding/milestones";
import { trackOnboardingEvent } from "@/lib/onboarding/telemetry";
import { canSpotlight, runMilestoneTour, waitForElement } from "./otto-tour";

/**
 * The frontend actions Otto may invoke, and the readables it may consult.
 *
 * Every handler re-validates before acting, even though the server already
 * did. The two checks guard different things: the server stops the model
 * inventing a milestone, this stops a route or selector that no longer exists
 * from turning into a broken navigation. Both failures are reported, never
 * thrown.
 */

const milestoneIdSchema = z.enum(MILESTONE_IDS);

const HELP_DOC_SLUGS = [
  "getting-started",
  "tender-matching",
  "document-editing",
  "pipeline-basics",
] as const;

export function OttoActions({
  onSeedRequest,
  onGuidanceOnly,
}: {
  /** Raised so the panel can render a confirmation before anything is created. */
  onSeedRequest: (milestoneId: MilestoneId) => void;
  /** Raised when spotlighting could not run, so the panel says so in chat. */
  onGuidanceOnly: (milestoneId: MilestoneId) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations("Otto");

  /**
   * The route allowlist is the registry's own set. An action carrying a route
   * that is not a milestone route is refused outright — that is the guarantee
   * that no model output can become a navigation target.
   */
  const navigate = useCallback(
    (route: string, milestoneId: MilestoneId): boolean => {
      if (!MILESTONE_ROUTES.includes(route)) {
        trackOnboardingEvent({
          name: "tool_call_failed",
          tool: "navigateTo",
          milestoneId,
          route,
          reason: "route_not_in_registry",
        });
        return false;
      }
      if (pathname !== route) router.push(route);
      return true;
    },
    [pathname, router],
  );

  useAgentAction({
    name: "navigateTo",
    schema: z.object({ milestoneId: milestoneIdSchema, route: z.string() }),
    handler: ({ milestoneId, route }) => {
      // Trust the registry over the payload: the route travelled through the
      // model's turn, the registry did not.
      navigate(MILESTONES[milestoneId].route || route, milestoneId);
    },
  });

  useAgentAction({
    name: "startMilestoneTour",
    schema: z.object({ milestoneId: milestoneIdSchema, route: z.string() }),
    handler: async ({ milestoneId }) => {
      const milestone = MILESTONES[milestoneId];
      trackOnboardingEvent({ name: "milestone_started", milestoneId });

      if (!navigate(milestone.route, milestoneId)) return;

      if (!canSpotlight()) {
        // Below md the sidebar collapses to a bottom bar and a spotlight
        // points at furniture that moved. Fall back to talking.
        onGuidanceOnly(milestoneId);
        return;
      }

      const shown = await runMilestoneTour({
        milestone,
        stepCopy: milestone.steps.map((step) => t(`steps.${step.copyKey}`)),
        doneLabel: t("panel.showMe"),
        nextLabel: t("panel.showMe"),
        onMissingStep: (failure) => {
          trackOnboardingEvent({
            name: "tool_call_failed",
            tool: "startMilestoneTour",
            milestoneId: failure.milestoneId,
            selector: failure.selector,
            route: failure.route,
            reason: "selector_not_found",
          });
        },
      });

      if (shown === 0) onGuidanceOnly(milestoneId);
    },
  });

  useAgentAction({
    name: "highlightElement",
    schema: z.object({
      milestoneId: milestoneIdSchema,
      stepIndex: z.number().int().min(0).optional(),
    }),
    handler: async ({ milestoneId, stepIndex }) => {
      const milestone = MILESTONES[milestoneId];
      const step = milestone.steps[stepIndex ?? 0];
      if (!step) {
        trackOnboardingEvent({
          name: "tool_call_failed",
          tool: "highlightElement",
          milestoneId,
          reason: "step_index_out_of_range",
        });
        return;
      }
      if (!canSpotlight()) {
        onGuidanceOnly(milestoneId);
        return;
      }
      const element = await waitForElement(step.selector);
      if (!element) {
        trackOnboardingEvent({
          name: "tool_call_failed",
          tool: "highlightElement",
          milestoneId,
          selector: step.selector,
          route: milestone.route,
          reason: "selector_not_found",
        });
        onGuidanceOnly(milestoneId);
        return;
      }
      await runMilestoneTour({
        milestone: { ...milestone, steps: [step] },
        stepCopy: [t(`steps.${step.copyKey}`)],
        doneLabel: t("panel.showMe"),
        nextLabel: t("panel.showMe"),
        onMissingStep: () => {},
      });
    },
  });

  useAgentAction({
    name: "openHelpDoc",
    schema: z.object({ slug: z.enum(HELP_DOC_SLUGS) }),
    handler: ({ slug }) => {
      // No docs surface exists yet, so this is honest about doing nothing
      // rather than opening a 404. The event is how we learn it is wanted.
      trackOnboardingEvent({
        name: "tool_call_failed",
        tool: "openHelpDoc",
        reason: `no_docs_panel:${slug}`,
      });
    },
  });

  useAgentAction({
    name: "seedDemoData",
    schema: z.object({ milestoneId: milestoneIdSchema }),
    // Never writes directly: the panel renders a confirmation first.
    handler: ({ milestoneId }) => onSeedRequest(milestoneId),
  });

  // Readables — so Otto stops guessing where the user is.
  useAgentReadable("currentRoute", pathname);
  useAgentReadable(
    "spotlightAvailable",
    typeof window === "undefined" ? null : canSpotlight(),
  );

  return null;
}
