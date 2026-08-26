"use client";

import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";

import { ChatMarkdown } from "@/components/chat/markdown";
import type { BlockKind, BlockState } from "@/lib/ai/iris/blocks";
import type { IrisFollowups, IrisUIMessage } from "@/lib/ai/iris/wire";
import { cn } from "@/lib/utils";

import { ActivityRail } from "./activity-rail";
import { IrisBlock } from "./block-renderer";
import { useIrisActions } from "./iris-context";

/**
 * One turn.
 *
 * Parts arrive in stream order and are rendered in stream order, with one
 * exception: tool parts are lifted out into the rail at the top. Left in
 * place they would interleave a technical log with the answer, and the whole
 * argument for this surface is that the answer is the block.
 */

type Part = IrisUIMessage["parts"][number];

function isDataPart(part: Part): part is Extract<Part, { type: `data-${string}` }> {
  return part.type.startsWith("data-");
}

function FollowupChips({ followups }: { followups: IrisFollowups }) {
  const t = useTranslations("GenUi");
  const { sendPrompt, isStreaming } = useIrisActions();
  if (followups.suggestions.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {t("followups.label")}
      </span>
      {followups.suggestions.map((suggestion) => (
        <button
          key={suggestion.prompt}
          type="button"
          disabled={isStreaming}
          onClick={() => sendPrompt(suggestion.prompt)}
          className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-50"
        >
          {suggestion.label}
        </button>
      ))}
    </div>
  );
}

function UserMessage({ message }: { message: IrisUIMessage }) {
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("");

  if (!text.trim()) return null;

  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm leading-relaxed text-primary-foreground">
        {text}
      </p>
    </div>
  );
}

function AssistantMessage({
  message,
  isLast,
  isStreaming,
}: {
  message: IrisUIMessage;
  isLast: boolean;
  isStreaming: boolean;
}) {
  const t = useTranslations("GenUi");

  const followups = message.parts.find(
    (part): part is Extract<Part, { type: "data-followups" }> => part.type === "data-followups",
  );

  const body = message.parts.filter(
    (part) => part.type === "text" || (isDataPart(part) && part.type !== "data-followups"),
  );

  // A turn whose model call has not produced anything yet: the rail is empty,
  // no block has opened. Without this the bubble is a blank rectangle.
  const pending = isLast && isStreaming && body.length === 0;

  return (
    <div className="flex gap-2.5">
      <span
        className={cn(
          "mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-linear-to-br from-primary to-[#7430c3] text-primary-foreground",
          isLast && isStreaming && "iris-breathe",
        )}
        aria-hidden
      >
        <Sparkles className="size-3.5" />
      </span>

      <div className="min-w-0 flex-1 space-y-2.5">
        <ActivityRail message={message} />

        {pending ? (
          <p className="text-xs text-muted-foreground">{t("thinking")}</p>
        ) : null}

        {body.map((part, index) => {
          if (part.type === "text") {
            const text = (part as { text: string }).text;
            if (!text.trim()) return null;
            return (
              <div
                key={`text-${index}`}
                className="text-sm leading-relaxed text-foreground [&_a]:text-primary [&_a]:underline"
              >
                <ChatMarkdown text={text} />
              </div>
            );
          }

          const kind = part.type.slice("data-".length) as BlockKind;
          const state = (part as { data: BlockState<BlockKind>; id?: string }).data;
          const blockId = (part as { id?: string }).id ?? `${message.id}-${index}`;
          return (
            <IrisBlock key={blockId} state={{ ...state, kind }} blockId={blockId} />
          );
        })}

        {followups && !isStreaming ? <FollowupChips followups={followups.data} /> : null}
      </div>
    </div>
  );
}

export function IrisMessage({
  message,
  isLast,
  isStreaming,
}: {
  message: IrisUIMessage;
  isLast: boolean;
  isStreaming: boolean;
}) {
  if (message.role === "user") return <UserMessage message={message} />;
  if (message.role !== "assistant") return null;
  return <AssistantMessage message={message} isLast={isLast} isStreaming={isStreaming} />;
}
