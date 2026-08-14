import { driver } from "driver.js";

import type { Milestone } from "@/lib/onboarding/milestones";

import "driver.js/dist/driver.css";

/**
 * Spotlighting, wrapped around driver.js.
 *
 * Two things this owns that the agent must never touch: resolving a step's
 * selector, and deciding what happens when it resolves to nothing. A tour that
 * silently highlights the wrong element — or nothing — is worse than no tour,
 * so an unresolved selector is dropped and REPORTED rather than rendered.
 */

/** Below this width the sidebar is a bottom bar and spotlighting misleads. */
export const SPOTLIGHT_MIN_WIDTH = 768;

export interface TourStepFailure {
  milestoneId: string;
  selector: string;
  route: string;
}

export interface RunTourInput {
  milestone: Milestone;
  /** Resolved i18n copy per step, in the milestone's own step order. */
  stepCopy: string[];
  doneLabel: string;
  nextLabel: string;
  backLabel: string;
  onMissingStep: (failure: TourStepFailure) => void;
}

export function canSpotlight(): boolean {
  if (typeof window === "undefined") return false;
  return window.innerWidth >= SPOTLIGHT_MIN_WIDTH;
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Wait for a selector to appear, because every tour step follows a navigation
 * and the target mounts after the route does. Resolves null on timeout rather
 * than throwing — a missing target is an expected, reportable outcome.
 */
export function waitForElement(
  selector: string,
  timeoutMs = 4000,
): Promise<Element | null> {
  if (typeof document === "undefined") return Promise.resolve(null);

  const existing = document.querySelector(selector);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (element: Element | null) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timer);
      resolve(element);
    };

    const observer = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) finish(found);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const timer = window.setTimeout(() => finish(null), timeoutMs);
  });
}

/**
 * Run a milestone's steps. Returns the number actually shown — zero means
 * every target was missing, which the caller surfaces as chat-only guidance
 * instead of pretending a tour happened.
 */
export async function runMilestoneTour(input: RunTourInput): Promise<number> {
  const { milestone } = input;
  if (!canSpotlight()) return 0;

  const resolved: Array<{
    element: Element;
    advanceOn: "next" | "click";
    config: {
      element: string;
      popover: { description: string; showButtons?: Array<"next" | "previous" | "close"> };
    };
  }> = [];

  for (const [index, step] of milestone.steps.entries()) {
    const element = await waitForElement(step.selector);
    if (!element) {
      // The drift alarm. A renamed data-tour attribute lands here, not in a
      // silently broken tour.
      input.onMissingStep({
        milestoneId: milestone.id,
        selector: step.selector,
        route: milestone.route,
      });
      continue;
    }
    const advanceOn = step.advanceOn ?? "next";
    resolved.push({
      element,
      advanceOn,
      config: {
        element: step.selector,
        popover: {
          description: input.stepCopy[index] ?? "",
          // On a click step, hiding Next is the whole point: the way onward
          // is to use the control, not to read past it.
          ...(advanceOn === "click"
            ? { showButtons: ["previous", "close"] as Array<"previous" | "close"> }
            : {}),
        },
      },
    });
  }

  if (resolved.length === 0) return 0;

  const reduced = prefersReducedMotion();
  // Listeners are tracked so a tour closed early cannot leave click handlers
  // on live controls, silently advancing a tour that is no longer running.
  const cleanups: Array<() => void> = [];
  const releaseAll = () => {
    while (cleanups.length) cleanups.pop()?.();
  };

  const instance = driver({
    showProgress: resolved.length > 1,
    animate: !reduced,
    smoothScroll: !reduced,
    overlayOpacity: 0.55,
    doneBtnText: input.doneLabel,
    nextBtnText: input.nextLabel,
    prevBtnText: input.backLabel,
    showButtons: ["next", "previous", "close"],
    steps: resolved.map((step) => step.config),
    onDestroyed: releaseAll,
    onHighlighted: (element) => {
      const step = resolved.find((candidate) => candidate.element === element);
      if (!step || step.advanceOn !== "click" || !element) return;

      // Wait for the user to actually use the control. Because the overlay
      // leaves the highlighted element interactive, this is a real click on
      // the real button — the tour follows the user, not the other way round.
      const onUse = () => {
        release();
        // Let the app's own handler run first; advancing mid-click makes the
        // next popover measure an element that is still moving.
        window.setTimeout(() => {
          if (instance.isActive()) instance.moveNext();
        }, 350);
      };
      const release = () => {
        element.removeEventListener("click", onUse);
        element.removeEventListener("keydown", onKey);
      };
      const onKey = (event: Event) => {
        const key = (event as KeyboardEvent).key;
        if (key === "Enter" || key === " ") onUse();
      };

      element.addEventListener("click", onUse, { once: true });
      element.addEventListener("keydown", onKey);
      cleanups.push(release);
    },
  });

  instance.drive();
  return resolved.length;
}
