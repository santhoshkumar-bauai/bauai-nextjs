import type { WireUiCall } from "./wire.ts";

/**
 * Per-turn collector for frontend-executed actions — the tender collector's
 * sibling for driving the UI.
 *
 * An agent that guides someone through the product has to do things a chat
 * bubble cannot: change route, spotlight a control, seed an example record.
 * The model must NOT be the one deciding how — letting it emit selectors or
 * URLs makes every restyle a silent breakage, and makes prompt injection a
 * navigation primitive. So the split is:
 *
 *   model → picks an ACTION NAME and a REGISTRY ID (both validated server-side)
 *   tool  → registers the call here and returns a short ack to the model
 *   here  → drained mid-turn and streamed as `ui` events
 *   client → re-validates args against the action's schema, then executes
 *
 * Fire-and-forget is deliberate. The model never learns whether the click
 * happened, because nothing downstream trusts its claim — completion is
 * decided by a real data check, not by the agent saying so.
 */

/** A turn that wants more UI changes than this is thrashing, not guiding. */
export const MAX_UI_CALLS = 8;

export type UiCallInput = Omit<WireUiCall, "id">;

export class UiCallCollector {
  private readonly calls: WireUiCall[] = [];
  /** Calls added since the last drain(); powers the live stream. */
  private pending: WireUiCall[] = [];
  private sequence = 0;
  private turnKey = "ui";

  /**
   * Namespace this turn's call ids, using something stable for the turn and
   * unique across turns — the persisted user message id.
   *
   * Without it every turn numbers from 1 and emits `ui-1`, while the client
   * de-duplicates against a set that lives for the whole session. The result
   * is that only the FIRST ui call of a session ever executes and every tour
   * afterwards is silently dropped.
   */
  setTurnKey(key: string): void {
    this.turnKey = key;
  }

  /** Returns the call id, so a tool can name it in its ack to the model. */
  add(input: UiCallInput): string | null {
    if (this.calls.length >= MAX_UI_CALLS) return null;

    this.sequence += 1;
    // Sequence-based within the turn, not random: ids must be stable across a
    // checkpoint replay so a resumed turn cannot re-run the same navigation.
    const call: WireUiCall = { id: `${this.turnKey}-${this.sequence}`, ...input };
    this.calls.push(call);
    this.pending.push(call);
    return call.id;
  }

  /** Everything requested this turn, in the order the tools asked for it. */
  list(): WireUiCall[] {
    return [...this.calls];
  }

  /** Calls added since the previous call; empties the queue. */
  drain(): WireUiCall[] {
    if (this.pending.length === 0) return [];
    const drained = this.pending;
    this.pending = [];
    return drained;
  }
}
