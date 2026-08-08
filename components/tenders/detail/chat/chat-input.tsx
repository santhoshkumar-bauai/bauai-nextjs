"use client";

import { Send, Square } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "next-intl";

export function ChatInput({
  onSend,
  onStop,
  sending,
  disabled,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  sending: boolean;
  disabled?: boolean;
}) {
  const t = useTranslations("Tenders.chat");
  const [text, setText] = useState("");

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    onSend(trimmed);
    setText("");
  };

  return (
    <div className="flex items-end gap-2 border-t border-border px-3 py-2.5">
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={t("placeholder")}
        rows={1}
        maxLength={4000}
        disabled={disabled}
        className="max-h-24 min-h-9 flex-1 resize-none rounded-lg border border-border bg-background px-2.5 py-2 text-xs outline-none focus:border-ring disabled:opacity-50"
      />
      {sending ? (
        <button
          type="button"
          onClick={onStop}
          aria-label={t("stop")}
          className="grid size-9 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground hover:bg-muted"
        >
          <Square className="size-3.5" />
        </button>
      ) : (
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !text.trim()}
          aria-label={t("send")}
          className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          <Send className="size-3.5" />
        </button>
      )}
    </div>
  );
}
