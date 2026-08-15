"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { MILESTONES, MILESTONE_IDS } from "@/lib/onboarding/milestones";

/**
 * Development-only guard: on every route change, check that the `data-tour`
 * targets the registry claims live on this route actually resolve.
 *
 * A broken tour is worse than no tour, and the failure mode is silent — a
 * refactor renames a wrapper, the attribute goes with it, and nobody finds out
 * until a new user is staring at a spotlight on nothing. This turns that into
 * a console error the moment you open the page in dev.
 *
 * Stripped from production builds by the NODE_ENV check.
 */
export function OttoSelectorCheck() {
  const pathname = usePathname();

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;

    const expected = MILESTONE_IDS.map((id) => MILESTONES[id]).filter(
      (milestone) =>
        milestone.route === pathname &&
        // Skip targets that only exist while the milestone is pending: on an
        // account that already did the work their absence is correct, and
        // crying wolf here trains people to ignore the real warnings. A
        // rename still fails selectors.test.ts.
        !milestone.targetVanishesWhenComplete,
    );
    if (expected.length === 0) return;

    // One frame plus a beat: these pages fetch, so a target inside a loading
    // skeleton is expected to be absent on the first tick.
    const timer = window.setTimeout(() => {
      const missing: string[] = [];
      for (const milestone of expected) {
        for (const step of milestone.steps) {
          if (!document.querySelector(step.selector)) {
            missing.push(`${milestone.id} → ${step.selector}`);
          }
        }
      }
      if (missing.length > 0) {
        console.error(
          `[otto] tour targets missing on ${pathname}:\n  ${missing.join("\n  ")}\n` +
            "Either the data-tour attribute was renamed or removed, or the target " +
            "is behind an empty/loading state. Check lib/onboarding/milestones.ts.",
        );
      }
    }, 1500);

    return () => window.clearTimeout(timer);
  }, [pathname]);

  return null;
}
