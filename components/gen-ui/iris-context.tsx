"use client";

import { createContext, useContext } from "react";

/**
 * What a generative-UI block is allowed to do to the conversation.
 *
 * Blocks are rendered deep inside a message list, and several of them are
 * INPUT surfaces — a choice prompt, a filter panel, a "compare these three"
 * button on a grid. Threading `sendMessage` down through six components would
 * make every block's props about plumbing instead of about its data, so the
 * two capabilities every block might want live in one context.
 *
 * Deliberately narrow: a block can start a turn and it can pin itself to the
 * canvas. It cannot mutate messages, rewrite history, or call the API.
 */
export interface IrisActions {
  /** Send `text` as the user's next turn. No-op while a turn is streaming. */
  sendPrompt: (text: string) => void;
  /** True while the agent is producing — interactive blocks disable on it. */
  isStreaming: boolean;
  /** Move a canvas-eligible block into the pinned panel. */
  pinBlock: (blockId: string) => void;
  /** Which block the canvas currently shows, if any. */
  pinnedBlockId: string | null;
}

const IrisActionsContext = createContext<IrisActions | null>(null);

export const IrisActionsProvider = IrisActionsContext.Provider;

export function useIrisActions(): IrisActions {
  const value = useContext(IrisActionsContext);
  if (!value) {
    throw new Error("useIrisActions must be used inside the Iris workspace.");
  }
  return value;
}
