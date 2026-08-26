"use client";

import { ArrowUp, Square } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The prompt bar.
 *
 * Two decisions worth naming. The textarea grows with its content up to a cap
 * instead of scrolling from line two, because a good prompt on this surface is
 * often a sentence with three tender titles in it. And the send button becomes
 * a stop button while streaming rather than sitting disabled beside one — the
 * user's next intent during a long turn is almost always "stop", and making
 * them find a second control for it is how a POC feels unfinished.
 */

const MAX_ROWS_PX = 168;

export function IrisComposer({
  onSubmit,
  onStop,
  isStreaming,
  disabled,
}: {
  onSubmit: (text: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}) {
  const t = useTranslations("GenUi.composer");
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_ROWS_PX)}px`;
  }, [value]);

  // Cmd/Ctrl+K from anywhere on the page focuses the composer. The surface is
  // a full-height app, not a page with a chat box on it.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        textareaRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const submit = () => {
    const text = value.trim();
    if (!text || isStreaming || disabled) return;
    setValue("");
    onSubmit(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        submit();
      }}
      className={cn(
        "rounded-2xl border border-border bg-card shadow-[0_2px_16px_rgba(25,23,36,0.06)] transition-shadow",
        "focus-within:border-ring/50 focus-within:ring-3 focus-within:ring-ring/15",
      )}
    >
      <textarea
        ref={textareaRef}
        rows={1}
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t("placeholder")}
        className="block w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
      />
      <div className="flex items-center gap-2 px-3 pb-2.5">
        <p className="truncate text-[10px] text-muted-foreground">{t("hint")}</p>
        {isStreaming ? (
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            onClick={onStop}
            aria-label={t("stop")}
            title={t("stop")}
            className="ml-auto"
          >
            <Square className="fill-current" />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon-sm"
            disabled={!value.trim() || disabled}
            aria-label={t("send")}
            title={t("send")}
            className="ml-auto rounded-full"
          >
            <ArrowUp />
          </Button>
        )}
      </div>
    </form>
  );
}
