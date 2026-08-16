"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { MILESTONES, MILESTONE_IDS } from "@/lib/onboarding/milestones";

/** How often the targets are re-checked while a page is still filling in. */
const POLL_MS = 500;
/** How long a target may stay absent before it counts as missing. */
const SETTLE_MS = 12_000;

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

    // Poll rather than take one snapshot: these pages fetch before they can
    // render a target, and the tender feed in particular waits on AI matching,
    // which routinely takes several seconds. A single early tick reported every
    // slow load as a broken tour — noise that trains people to ignore this.
    const started = Date.now();
    const missingNow = () =>
      expected.flatMap((milestone) =>
        milestone.steps
          .filter((step) => !document.querySelector(step.selector))
          .map((step) => `${milestone.id} → ${step.selector}`),
      );

    const timer = window.setInterval(() => {
      const missing = missingNow();
      if (missing.length === 0) {
        window.clearInterval(timer);
        return;
      }
      if (Date.now() - started < SETTLE_MS) return;
      window.clearInterval(timer);
      console.error(
        `[otto] tour targets missing on ${pathname}:\n  ${missing.join("\n  ")}\n` +
          "Either the data-tour attribute was renamed or removed, or the target " +
          "is behind an empty/loading state. Check lib/onboarding/milestones.ts.",
      );
    }, POLL_MS);

    return () => window.clearInterval(timer);
  }, [pathname]);

  return null;
}
