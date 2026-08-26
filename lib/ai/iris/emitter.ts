import {
  BLOCK_SCHEMAS,
  type BlockKind,
  type BlockPayload,
  type BlockState,
} from "./blocks.ts";

/**
 * Per-turn collector for generative-UI blocks — Iris's equivalent of Clara's
 * `TenderRefCollector` / `UiCallCollector`, but PUSH-based.
 *
 * Clara's collectors are drained by the route between supersteps, which is
 * fine when the payload is a card strip rendered under a finished answer. A
 * generative-UI turn is the opposite: the block IS the answer, and a grid that
 * only appears after the model has finished writing about it reads as broken.
 * So a tool opens a slot the moment it starts (the client draws the skeleton),
 * then fills it (the client swaps in the component under the same id).
 *
 * The emitter owns id allocation for exactly the reason the ui-call collector
 * does: ids are sequence-based within the turn and namespaced by a turn key,
 * so a resumed or replayed turn re-emits the SAME id and the client reconciles
 * instead of stacking duplicates.
 */

export interface BlockEvent {
  id: string;
  kind: BlockKind;
  state: BlockState<BlockKind>;
}

/**
 * A turn that renders more than this is not answering, it is redecorating.
 * The cap is per turn, not per tool, so one tool cannot starve the rest.
 */
export const MAX_BLOCKS_PER_TURN = 10;

/** Handle for one open slot. Returned by `open()`, resolved exactly once. */
export interface BlockHandle<K extends BlockKind> {
  id: string;
  /** Validates against the catalog schema. False = dropped, nothing rendered. */
  ready(payload: BlockPayload<K>): boolean;
  /** Renders the block's empty/failed state, with a locale-resolved message. */
  fail(message: string): void;
}

export class BlockEmitter {
  private listener: ((event: BlockEvent) => void) | null = null;
  private sequence = 0;
  private turnKey = "block";
  private readonly opened: BlockKind[] = [];
  private readonly rendered: BlockKind[] = [];

  /**
   * Namespace this turn's block ids. Same trap as `UiCallCollector.setTurnKey`:
   * without it every turn numbers from 1, and a client that reconciles on id
   * across the whole conversation would overwrite the first turn's grid with
   * the second turn's.
   */
  setTurnKey(key: string): void {
    this.turnKey = key;
  }

  /** The stream bridge subscribes before the graph runs. */
  subscribe(listener: (event: BlockEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  /** Kinds that actually reached `ready` — used for the turn's metadata. */
  renderedKinds(): BlockKind[] {
    return [...this.rendered];
  }

  /** Null when the per-turn cap is spent; the tool tells the model so. */
  open<K extends BlockKind>(kind: K, title?: string): BlockHandle<K> | null {
    if (this.opened.length >= MAX_BLOCKS_PER_TURN) return null;

    this.sequence += 1;
    const id = `${this.turnKey}-${this.sequence}`;
    this.opened.push(kind);
    this.emit({ id, kind, state: { status: "loading", kind, ...(title ? { title } : {}) } });

    let settled = false;
    return {
      id,
      ready: (payload) => {
        if (settled) return false;
        // Validated here rather than at the tool's edge so that EVERY path
        // into the UI goes through the catalog. A block that fails validation
        // is a bug in the builder, and rendering half of it would hide it.
        const parsed = BLOCK_SCHEMAS[kind].safeParse(payload);
        if (!parsed.success) {
          settled = true;
          this.emit({ id, kind, state: { status: "error", kind, message: "invalid_block" } });
          return false;
        }
        settled = true;
        this.rendered.push(kind);
        this.emit({
          id,
          kind,
          state: { status: "ready", kind, block: parsed.data as BlockPayload<K> },
        });
        return true;
      },
      fail: (message) => {
        if (settled) return;
        settled = true;
        this.emit({ id, kind, state: { status: "error", kind, message } });
      },
    };
  }

  private emit(event: BlockEvent): void {
    this.listener?.(event);
  }
}
