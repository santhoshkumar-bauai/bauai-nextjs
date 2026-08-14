/**
 * Onboarding telemetry.
 *
 * This repo has no frontend analytics vendor and this is not the change that
 * should introduce one. Events go to our own endpoint, which writes a Mongo
 * document and logs through the existing ingestion logger — greppable in the
 * same place as every other server signal.
 *
 * The events that matter most are the failures. `tool_call_failed` with an
 * unknown milestone id or a missing selector is the drift alarm: it fires when
 * the registry and the real UI have gone out of sync, which is exactly the
 * silent breakage a guided tour is prone to.
 */

export const ONBOARDING_EVENTS = [
  "onboarding_started",
  "milestone_started",
  "milestone_completed",
  "tool_call_failed",
  "onboarding_dismissed",
  "onboarding_completed",
] as const;

export type OnboardingEventName = (typeof ONBOARDING_EVENTS)[number];

export interface OnboardingEvent {
  name: OnboardingEventName;
  milestoneId?: string;
  /** Action or tool name, for `tool_call_failed`. */
  tool?: string;
  reason?: string;
  selector?: string;
  route?: string;
}

/**
 * Fire-and-forget from the browser. Never awaited by UI code and never allowed
 * to throw: losing an analytics event must not break a tour step.
 */
export function trackOnboardingEvent(event: OnboardingEvent): void {
  if (typeof window === "undefined") return;
  try {
    const body = JSON.stringify(event);
    // `sendBeacon` survives the navigations this agent causes on purpose;
    // a pending fetch would be cancelled by the very route change it reports.
    if (navigator.sendBeacon) {
      navigator.sendBeacon(
        "/api/otto/events",
        new Blob([body], { type: "application/json" }),
      );
      return;
    }
    void fetch("/api/otto/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Telemetry is never worth an exception in a user-facing path.
  }
}
