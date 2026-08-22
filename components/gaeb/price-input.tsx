"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import { formatUnitPrice, parsePriceInput } from "./price-format";

/**
 * Inline unit-price cell. Accepts both decimal conventions ("1.234,56" and
 * "1234.56"), formats per locale on blur, commits on Enter/blur, reverts on
 * Escape. Invalid input keeps the previous value rather than destroying it.
 */
export function PriceInput({
  value,
  locale,
  disabled = false,
  tone = null,
  ariaLabel,
  onCommit,
}: {
  value: number | null;
  locale: string;
  disabled?: boolean;
  /** Provenance accent: how the current price came to be. */
  tone?: "accepted" | "edited" | "manual" | "rejected" | null;
  ariaLabel: string;
  onCommit: (value: number | null) => void;
}) {
  const [text, setText] = useState(formatUnitPrice(value, locale));
  const [focused, setFocused] = useState(false);
  const lastValueRef = useRef(value);

  useEffect(() => {
    // External updates (bulk accept, reload) win only while not editing.
    if (!focused && lastValueRef.current !== value) {
      lastValueRef.current = value;
      setText(formatUnitPrice(value, locale));
    }
  }, [focused, locale, value]);

  const commit = () => {
    const parsed = parsePriceInput(text, locale);
    if (parsed === undefined) {
      setText(formatUnitPrice(value, locale));
      return;
    }
    lastValueRef.current = parsed;
    setText(formatUnitPrice(parsed, locale));
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={ariaLabel}
      disabled={disabled}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onFocus={(event) => {
        setFocused(true);
        event.target.select();
      }}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          setText(formatUnitPrice(value, locale));
          event.currentTarget.blur();
        }
      }}
      className={cn(
        "h-8 w-full rounded-md border bg-white px-2 text-right text-[13px] tabular-nums text-foreground outline-none transition-colors",
        "border-border focus:border-primary/50 focus:ring-2 focus:ring-primary/15",
        "disabled:cursor-not-allowed disabled:bg-muted/40 disabled:text-muted-foreground",
        tone === "accepted" && "border-primary/40 bg-primary/[0.04]",
        tone === "edited" && "border-amber-400/60 bg-amber-50/60",
        tone === "rejected" && "border-dashed",
      )}
    />
  );
}
