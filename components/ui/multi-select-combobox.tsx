"use client";

import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, LoaderCircle, Plus, X } from "lucide-react";

import { cn } from "@/lib/utils";

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
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const results = await loadOptions(query);
        if (current) setRemoteOptions(results);
      } finally {
        if (current) setLoading(false);
      }
    }, query ? 280 : 0);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [loadOptions, query]);

  const selectedKeys = useMemo(() => new Set(value.map((item) => item.value.toLowerCase())), [value]);
  const visibleOptions = useMemo(() => {
    const source = loadOptions ? remoteOptions : options;
    const normalizedQuery = query.trim().toLowerCase();
    return source.filter((option) =>
      !selectedKeys.has(option.value.toLowerCase()) &&
      (!normalizedQuery || option.label.toLowerCase().includes(normalizedQuery)),
    ).slice(0, 12);
  }, [loadOptions, options, query, remoteOptions, selectedKeys]);

  const customValue = query.trim();
  const canAddCustom = allowCustom && customValue.length > 0 &&
    !selectedKeys.has(customValue.toLowerCase()) &&
    !options.some((option) => option.label.toLowerCase() === customValue.toLowerCase());

  const add = (option: ComboboxOption) => {
    if (!selectedKeys.has(option.value.toLowerCase())) onChange([...value, option]);
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
    <div className="multi-combobox" ref={rootRef}>
      <div
        className={cn("multi-combobox-control", open && "is-open", disabled && "is-disabled")}
        onClick={() => {
          if (!disabled) {
            setOpen(true);
            inputRef.current?.focus();
          }
        }}
      >
        {value.map((item) => (
          <span className="selection-chip" key={item.value} title={item.label}>
            <span>{item.label}</span>
            <button
              type="button"
              aria-label={`Remove ${item.label}`}
              onClick={(event) => {
                event.stopPropagation();
                onChange(value.filter((selected) => selected.value !== item.value));
              }}
            ><X size={13} /></button>
          </span>
        ))}
        <input
          ref={inputRef}
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={`${ariaLabel.replace(/\s+/g, "-").toLowerCase()}-listbox`}
          disabled={disabled}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={value.length ? "" : placeholder}
        />
        {loading ? <LoaderCircle className="combobox-spinner" size={17} /> : <ChevronDown className="combobox-chevron" size={17} />}
      </div>

      {open && !disabled && (
        <div className="combobox-popover" id={`${ariaLabel.replace(/\s+/g, "-").toLowerCase()}-listbox`} role="listbox">
          {loading && !visibleOptions.length ? (
            <p className="combobox-message"><LoaderCircle size={15} />{loadingText}</p>
          ) : (
            <>
              {visibleOptions.map((option) => (
                <button type="button" role="option" aria-selected="false" key={option.value} onMouseDown={(event) => event.preventDefault()} onClick={() => add(option)}>
                  <span>{option.label}</span><Check size={15} />
                </button>
              ))}
              {canAddCustom && (
                <button type="button" className="combobox-add" onMouseDown={(event) => event.preventDefault()} onClick={() => add({ value: customValue, label: customValue })}>
                  <Plus size={15} /><span>{addText ? addText(customValue) : customValue}</span>
                </button>
              )}
              {!visibleOptions.length && !canAddCustom && !loading && <p className="combobox-message">{emptyText}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
