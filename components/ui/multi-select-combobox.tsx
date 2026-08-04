"use client";

import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, LoaderCircle, Plus, X } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  popover,
  popoverMessage,
  popoverOption,
} from "@/components/onboarding/onboarding-tailwind";

export type ComboboxOption = { value: string; label: string };

type MultiSelectComboboxProps = {
  value: ComboboxOption[];
  onChange: (value: ComboboxOption[]) => void;
  options?: ComboboxOption[];
  loadOptions?: (query: string) => Promise<ComboboxOption[]>;
  placeholder: string;
  emptyText: string;
  loadingText: string;
  addText?: (value: string) => string;
  allowCustom?: boolean;
  disabled?: boolean;
  ariaLabel: string;
};

export function MultiSelectCombobox({
  value,
  onChange,
  options = [],
  loadOptions,
  placeholder,
  emptyText,
  loadingText,
  addText,
  allowCustom = false,
  disabled = false,
  ariaLabel,
}: MultiSelectComboboxProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [remoteOptions, setRemoteOptions] = useState<ComboboxOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  useEffect(() => {
    if (!loadOptions) return;
    let current = true;
    const timer = window.setTimeout(
      async () => {
        setLoading(true);
        try {
          const results = await loadOptions(query);
          if (current) setRemoteOptions(results);
        } finally {
          if (current) setLoading(false);
        }
      },
      query ? 280 : 0,
    );
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [loadOptions, query]);

  const selectedKeys = useMemo(
    () => new Set(value.map((item) => item.value.toLowerCase())),
    [value],
  );
  const visibleOptions = useMemo(() => {
    const source = loadOptions ? remoteOptions : options;
    const normalizedQuery = query.trim().toLowerCase();
    return source
      .filter(
        (option) =>
          !selectedKeys.has(option.value.toLowerCase()) &&
          (!normalizedQuery ||
            option.label.toLowerCase().includes(normalizedQuery)),
      )
      .slice(0, 12);
  }, [loadOptions, options, query, remoteOptions, selectedKeys]);

  const customValue = query.trim();
  const canAddCustom =
    allowCustom &&
    customValue.length > 0 &&
    !selectedKeys.has(customValue.toLowerCase()) &&
    !options.some(
      (option) => option.label.toLowerCase() === customValue.toLowerCase(),
    );

  const add = (option: ComboboxOption) => {
    if (!selectedKeys.has(option.value.toLowerCase()))
      onChange([...value, option]);
    setQuery("");
    setOpen(true);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (canAddCustom) add({ value: customValue, label: customValue });
      else if (visibleOptions[0]) add(visibleOptions[0]);
    } else if (event.key === "Backspace" && !query && value.length) {
      onChange(value.slice(0, -1));
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="relative w-full text-[#25212a]" ref={rootRef}>
      <div
        className={cn(
          "flex min-h-[50px] cursor-text flex-wrap items-center gap-[7px] py-[7px] pr-7",
          disabled && "cursor-not-allowed opacity-65",
        )}
        onClick={() => {
          if (!disabled) {
            setOpen(true);
            inputRef.current?.focus();
          }
        }}
      >
        {value.map((item) => (
          <span
            className="inline-flex max-w-full items-center gap-1 rounded-lg border border-[#ded0ec] bg-[#f3eafa] py-1.5 pr-[7px] pl-2.5 text-xs font-semibold text-[#5c179f]"
            key={item.value}
            title={item.label}
          >
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">
              {item.label}
            </span>
            <button
              className="grid size-[19px] shrink-0 cursor-pointer place-items-center rounded-[5px] border-0 bg-transparent p-0 text-inherit hover:bg-[rgba(92,23,159,.12)]"
              type="button"
              aria-label={`Remove ${item.label}`}
              onClick={(event) => {
                event.stopPropagation();
                onChange(
                  value.filter((selected) => selected.value !== item.value),
                );
              }}
            >
              <X size={13} />
            </button>
          </span>
        ))}
        <input
          className="h-[34px] min-w-[100px] flex-[1_1_180px] border-0 bg-transparent text-sm text-[#25212a] outline-none placeholder:text-[#a5a9b8]"
          ref={inputRef}
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={`${ariaLabel.replace(/\s+/g, "-").toLowerCase()}-listbox`}
          disabled={disabled}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={value.length ? "" : placeholder}
        />
        {loading ? (
          <LoaderCircle
            className="absolute top-[17px] right-[9px] animate-spin text-[#9690a1]"
            size={17}
          />
        ) : (
          <ChevronDown
            className="absolute top-[17px] right-[9px] text-[#9690a1]"
            size={17}
          />
        )}
      </div>

      {open && !disabled && (
        <div
          className={popover}
          id={`${ariaLabel.replace(/\s+/g, "-").toLowerCase()}-listbox`}
          role="listbox"
        >
          {loading && !visibleOptions.length ? (
            <p className={popoverMessage}>
              <LoaderCircle className="animate-spin" size={15} />
              {loadingText}
            </p>
          ) : (
            <>
              {visibleOptions.map((option) => (
                <button
                  className={`${popoverOption} [&>svg]:shrink-0 [&>svg]:opacity-0 hover:[&>svg]:opacity-100`}
                  type="button"
                  role="option"
                  aria-selected="false"
                  key={option.value}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => add(option)}
                >
                  <span>{option.label}</span>
                  <Check size={15} />
                </button>
              ))}
              {canAddCustom && (
                <button
                  type="button"
                  className={`${popoverOption} justify-start border-t border-[#f0eaf4] font-semibold text-[#6f1eb9] [&>svg]:opacity-100`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() =>
                    add({ value: customValue, label: customValue })
                  }
                >
                  <Plus size={15} />
                  <span>{addText ? addText(customValue) : customValue}</span>
                </button>
              )}
              {!visibleOptions.length && !canAddCustom && !loading && (
                <p className={popoverMessage}>{emptyText}</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
