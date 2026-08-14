import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MILESTONES, MILESTONE_IDS } from "./milestones.ts";

/**
 * The registry-to-markup contract, checked statically.
 *
 * `OttoSelectorCheck` catches a missing target at runtime in dev, but only if
 * someone opens that page. This catches the same drift in CI: every
 * `data-tour` value the registry points at must exist somewhere in the
 * component tree. Renaming an attribute without updating the registry fails
 * here instead of silently producing a tour that highlights nothing.
 *
 * It cannot prove the attribute is on the RIGHT element, or that it renders
 * under the current empty/permission state — that is what the dev-only runtime
 * check and the milestone `requiresMatchEnabled` / `relevantFor` guards are
 * for.
 */

const COMPONENT_ROOT = join(process.cwd(), "components");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

const markup = sourceFiles(COMPONENT_ROOT)
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

describe("tour selectors exist in the component tree", () => {
  for (const id of MILESTONE_IDS) {
    const milestone = MILESTONES[id];
    for (const step of milestone.steps) {
      const tourId = step.selector.replace(/^\[data-tour="|"\]$/g, "");

      it(`${id} → data-tour="${tourId}"`, () => {
        // Matches both the literal attribute and the `tourId="…"` prop used
        // where a shared component forwards it (StateCard).
        const present =
          markup.includes(`data-tour="${tourId}"`) ||
          markup.includes(`tourId="${tourId}"`);

        expect(
          present,
          `No component renders data-tour="${tourId}". Either restore the ` +
            `attribute or update lib/onboarding/milestones.ts.`,
        ).toBe(true);
      });
    }
  }
});
