import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";

/**
 * Deterministic chat model for graph tests: replays a scripted queue of
 * AIMessages (which may carry tool_calls). Mirrors real model semantics:
 * `bindTools` returns a NEW instance flagged as tool-bound that SHARES the
 * queue and call log — so the finalize path (invoked on the unbound base)
 * is distinguishable in `calls[i].withTools`.
 */
export class FakeToolCallingChatModel extends BaseChatModel {
  queue: AIMessage[];
  /** Shared across bound views: whether each call had tools bound. */
  calls: Array<{ withTools: boolean; messageCount: number }>;
  toolsBound = false;

  constructor(responses: AIMessage[], params: BaseChatModelParams = {}) {
    super(params);
    this.queue = [...responses];
    this.calls = [];
  }

  _llmType(): string {
    return "fake-tool-calling";
  }

  override bindTools(): FakeToolCallingChatModel {
    const bound = new FakeToolCallingChatModel([]);
    bound.queue = this.queue; // shared reference
    bound.calls = this.calls; // shared reference
    bound.toolsBound = true;
    return bound;
  }

  private nextMessage(messageCount: number): { message: AIMessage; text: string } {
    this.calls.push({ withTools: this.toolsBound, messageCount });
    const message = this.queue.shift() ?? new AIMessage("(queue empty)");
    const text = typeof message.content === "string" ? message.content : "";
    return { message, text };
  }

  async _generate(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const { message, text } = this.nextMessage(messages.length);
    if (text.length > 0 && runManager) {
      const mid = Math.ceil(text.length / 2);
      await runManager.handleLLMNewToken(text.slice(0, mid));
      await runManager.handleLLMNewToken(text.slice(mid));
    }
    return { generations: [{ text, message }] };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const { message, text } = this.nextMessage(messages.length);

    if (message.tool_calls?.length) {
      yield new ChatGenerationChunk({
        text: "",
        message: new AIMessageChunk({
          content: "",
          tool_calls: message.tool_calls,
          tool_call_chunks: message.tool_calls.map((call, index) => ({
            name: call.name,
            args: JSON.stringify(call.args),
            id: call.id,
            index,
            type: "tool_call_chunk" as const,
          })),
        }),
      });
      return;
    }

    const mid = Math.ceil(text.length / 2) || 1;
    for (const part of [text.slice(0, mid), text.slice(mid)]) {
      if (!part) continue;
      await runManager?.handleLLMNewToken(part);
      yield new ChatGenerationChunk({
        text: part,
        message: new AIMessageChunk({ content: part }),
      });
    }
  }
}
