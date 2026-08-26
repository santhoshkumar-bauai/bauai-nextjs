"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { ArrowDown, ArrowLeft, PanelRight, RotateCcw, Sparkles } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAiErrorMessage } from "@/components/chat/use-ai-error-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CANVAS_BLOCKS, type BlockKind, type BlockState } from "@/lib/ai/iris/blocks";
import type { IrisUIMessage } from "@/lib/ai/iris/wire";
import { cn } from "@/lib/utils";

import { IrisCanvas, type CanvasEntry } from "./iris-canvas";
import { IrisComposer } from "./iris-composer";
import { IrisEmptyState } from "./iris-empty-state";
import { IrisActionsProvider } from "./iris-context";
import { IrisMessage } from "./iris-message";

/**
 * Iris — the generative-UI agent POC.
 *
 * The client is a plain `useChat`. That is the point of routing the LangGraph
 * agent through the AI SDK's stream format: message state, streaming
 * reconciliation, abort and typed parts all come from the SDK, and everything
 * written here is about the SURFACE — what to pin, when to stick to the
 * bottom, how the blocks and the prose share a column.
 */

/** Blocks pinnable to the canvas, newest last. */
function collectCanvasEntries(messages: IrisUIMessage[]): CanvasEntry[] {
  const entries: CanvasEntry[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const [index, part] of message.parts.entries()) {
      if (!part.type.startsWith("data-")) continue;
      const kind = part.type.slice("data-".length) as BlockKind;
      if (!CANVAS_BLOCKS.includes(kind)) continue;
      const state = (part as { data?: BlockState<BlockKind> }).data;
      if (state?.status !== "ready") continue;
      entries.push({
        id: (part as { id?: string }).id ?? `${message.id}-${index}`,
        state: { ...state, kind },
      });
    }
  }
  // Older sessions accumulate; four tabs is already more than anyone flips
  // between, and the panel is a working surface, not a history.
  return entries.slice(-4);
}

export function IrisWorkspace({
  companyName,
  aiAvailable,
}: {
  companyName: string;
  aiAvailable: boolean;
}) {
  const t = useTranslations("GenUi");
  const errorMessage = useAiErrorMessage();

  const transport = useMemo(
    () => new DefaultChatTransport<IrisUIMessage>({ api: "/api/poc/gen-ui/chat" }),
    [],
  );
  const { messages, sendMessage, status, stop, error, clearError, setMessages } =
    useChat<IrisUIMessage>({ transport });

  const isStreaming = status === "streaming" || status === "submitted";

  // --- canvas ------------------------------------------------------------

  const canvasEntries = useMemo(() => collectCanvasEntries(messages), [messages]);
  /** An explicit pin. `null` means "follow whatever arrived last". */
  const [pinnedOverride, setPinnedOverride] = useState<string | null>(null);
  const [canvasClosed, setCanvasClosed] = useState(false);

  // Derived during render rather than synced in an effect: the panel follows
  // the newest pinnable block, unless the reader picked one and it is still on
  // the canvas. An override that scrolled out of the four-tab window falls
  // back rather than pinning nothing.
  const pinnedId =
    canvasEntries.some((entry) => entry.id === pinnedOverride)
      ? pinnedOverride
      : (canvasEntries[canvasEntries.length - 1]?.id ?? null);

  const canvasOpen = !canvasClosed && canvasEntries.length > 0;

  const pinBlock = useCallback((blockId: string) => {
    setPinnedOverride(blockId);
    setCanvasClosed(false);
  }, []);

  // --- scrolling ---------------------------------------------------------

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setAtBottom(distance < 120);
  }, []);

  useEffect(() => {
    // Stick to the bottom only while the reader is already there. Blocks land
    // mid-stream and can be tall; yanking someone back down while they are
    // reading an evidence card is the classic chat-UI sin.
    if (!atBottom) return;
    bottomRef.current?.scrollIntoView({ behavior: isStreaming ? "auto" : "smooth" });
  }, [messages, atBottom, isStreaming]);

  // --- actions -----------------------------------------------------------

  const sendPrompt = useCallback(
    (text: string) => {
      if (isStreaming || !aiAvailable) return;
      clearError();
      setAtBottom(true);
      void sendMessage({ text });
    },
    [aiAvailable, clearError, isStreaming, sendMessage],
  );

  const actions = useMemo(
    () => ({ sendPrompt, isStreaming, pinBlock, pinnedBlockId: pinnedId }),
    [sendPrompt, isStreaming, pinBlock, pinnedId],
  );

  const blockCount = useMemo(
    () =>
      messages.reduce(
        (sum, message) =>
          sum +
          message.parts.filter(
            (part) =>
              part.type.startsWith("data-") &&
              part.type !== "data-followups" &&
              (part as { data?: { status?: string } }).data?.status === "ready",
          ).length,
        0,
      ),
    [messages],
  );

  return (
    <IrisActionsProvider value={actions}>
      <div className="fixed inset-0 flex min-h-0 flex-col overflow-clip bg-background">
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
          <Link
            href="/dashboard"
            className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            {t("back")}
          </Link>

          <div className="mx-1 h-4 w-px bg-border" />

          <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-linear-to-br from-primary to-[#7430c3] text-primary-foreground">
            <Sparkles className="size-3" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight text-foreground">
              {t("title")}
            </p>
            <p className="truncate text-[11px] text-muted-foreground">{t("subtitle")}</p>
          </div>

          <Badge variant="primary" className="ml-2 hidden sm:inline-flex">
            {t("poc")}
          </Badge>
          {blockCount > 0 ? (
            <Badge variant="neutral" className="hidden sm:inline-flex">
              {t("blocksRendered", { count: blockCount })}
            </Badge>
          ) : null}

          <div className="ml-auto flex items-center gap-1">
            {canvasEntries.length > 0 ? (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setCanvasClosed((closed) => !closed)}
                aria-label={t("canvas.toggle")}
                title={t("canvas.toggle")}
                className={cn(
                  "hidden text-muted-foreground lg:inline-flex",
                  canvasOpen && "bg-primary/10 text-primary",
                )}
              >
                <PanelRight />
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              disabled={messages.length === 0 || isStreaming}
              onClick={() => {
                setMessages([]);
                clearError();
                setPinnedOverride(null);
              }}
              className="text-muted-foreground"
            >
              <RotateCcw />
              <span className="hidden sm:inline">{t("reset")}</span>
            </Button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <main className="relative flex min-w-0 flex-1 flex-col">
            <div
              ref={scrollRef}
              onScroll={onScroll}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
            >
              <div className="mx-auto w-full max-w-3xl space-y-5 px-4 pt-4 pb-6">
                {messages.length === 0 ? (
                  <IrisEmptyState companyName={companyName} />
                ) : (
                  messages.map((message, index) => (
                    <IrisMessage
                      key={message.id}
                      message={message}
                      isLast={index === messages.length - 1}
                      isStreaming={isStreaming}
                    />
                  ))
                )}

                {error ? (
                  <div className="flex items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5">
                    <p className="min-w-0 flex-1 text-xs text-rose-800">
                      {errorMessage(error.message)}
                    </p>
                    <Button size="xs" variant="outline" onClick={() => clearError()}>
                      {t("dismiss")}
                    </Button>
                  </div>
                ) : null}

                <div ref={bottomRef} />
              </div>
            </div>

            {!atBottom ? (
              <Button
                size="icon-sm"
                variant="outline"
                aria-label={t("scrollToBottom")}
                onClick={() => {
                  setAtBottom(true);
                  bottomRef.current?.scrollIntoView({ behavior: "smooth" });
                }}
                className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-md"
              >
                <ArrowDown />
              </Button>
            ) : null}

            <div className="shrink-0 border-t border-border bg-linear-to-b from-transparent to-muted/30 px-4 py-3">
              <div className="mx-auto w-full max-w-3xl">
                {aiAvailable ? (
                  <IrisComposer
                    onSubmit={sendPrompt}
                    onStop={stop}
                    isStreaming={isStreaming}
                  />
                ) : (
                  <p className="rounded-xl border border-dashed border-border bg-muted/40 px-4 py-3 text-center text-xs text-muted-foreground">
                    {t("unavailable")}
                  </p>
                )}
              </div>
            </div>
          </main>

          {canvasOpen ? (
            <IrisCanvas
              entries={canvasEntries}
              pinnedId={pinnedId}
              onPin={setPinnedOverride}
              // Closing sticks: every pinned block is also inline in the
              // transcript, so nothing is hidden, and the header toggle
              // brings the panel back in one click.
              onClose={() => setCanvasClosed(true)}
            />
          ) : null}
        </div>
      </div>
    </IrisActionsProvider>
  );
}
