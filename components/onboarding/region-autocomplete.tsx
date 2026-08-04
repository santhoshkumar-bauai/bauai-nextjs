"use client";

import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, MapPin, Search } from "lucide-react";
import {
  onboardingInput,
  popover,
  popoverMessage,
  popoverOption,
} from "./onboarding-tailwind";

export type SelectedRegion = {
  label: string;
  placeId?: string;
  latitude?: number;
  longitude?: number;
};

type RegionSuggestion = {
  placeId: string;
  label: string;
  primary: string;
  secondary: string;
};

type RegionAutocompleteProps = {
  locale: string;
  value: SelectedRegion | null;
  onChange: (region: SelectedRegion | null) => void;
  placeholder: string;
  searchingText: string;
  emptyText: string;
  attribution: string;
  formatTypedRegion: (value: string) => string;
};

export function RegionAutocomplete({
  locale,
  value,
  onChange,
  placeholder,
  searchingText,
  emptyText,
  attribution,
  formatTypedRegion,
}: RegionAutocompleteProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(value?.label || "");
  const [items, setItems] = useState<RegionSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  useEffect(() => {
    if (query.trim().length < 3 || query === value?.label) {
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ q: query, locale });
        const response = await fetch(`/api/locations?${params}`, {
          signal: controller.signal,
        });
        const result = (await response.json()) as {
          items?: RegionSuggestion[];
        };
        if (response.ok) setItems(result.items || []);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError"))
          setItems([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 380);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [locale, query, value?.label]);

  const select = async (item: RegionSuggestion) => {
    setResolving(true);
    try {
      const params = new URLSearchParams({ placeId: item.placeId, locale });
      const response = await fetch(`/api/locations/details?${params}`);
      const result = (await response.json()) as SelectedRegion;
      if (response.ok) {
        onChange(result);
        setQuery(result.label);
        setOpen(false);
        setItems([]);
      } else {
        confirmManualRegion(item.label);
      }
    } finally {
      setResolving(false);
    }
  };

  const confirmManualRegion = (label = query) => {
    const normalizedLabel = label.trim();
    if (!normalizedLabel) return;
    onChange({ label: normalizedLabel });
    setQuery(normalizedLabel);
    setOpen(false);
    setItems([]);
  };

  return (
    <div className="relative" ref={rootRef}>
      <div className={`${onboardingInput} relative text-[#8f96ad]`}>
        <MapPin size={18} />
        <input
          value={query}
          role="combobox"
          aria-expanded={open}
          aria-controls="region-suggestions"
          aria-autocomplete="list"
          placeholder={placeholder}
          required
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setItems([]);
            onChange(null);
            setOpen(true);
          }}
        />
        {loading || resolving ? (
          <LoaderCircle className="shrink-0 animate-spin" size={17} />
        ) : value ? (
          <Check className="shrink-0 text-[#1e9a5b]" size={17} />
        ) : (
          <Search className="shrink-0" size={16} />
        )}
      </div>
      {open && query.trim().length >= 3 && query !== value?.label && (
        <div
          className={`${popover} right-0 left-0`}
          id="region-suggestions"
          role="listbox"
        >
          {loading ? (
            <p className={popoverMessage}>
              <LoaderCircle className="animate-spin" size={15} />
              {searchingText}
            </p>
          ) : (
            <>
              {items.map((item) => (
                <button
                  className={`${popoverOption} justify-start [&>svg]:shrink-0 [&>svg]:text-[#8b54bc]`}
                  type="button"
                  role="option"
                  aria-selected="false"
                  key={item.placeId}
                  onClick={() => select(item)}
                >
                  <MapPin size={16} />
                  <span className="grid gap-1">
                    <strong className="text-[13px] font-semibold">
                      {item.primary}
                    </strong>
                    {item.secondary && (
                      <small className="text-[11px] text-[#89828f]">
                        {item.secondary}
                      </small>
                    )}
                  </span>
                </button>
              ))}
              {!items.length && <p className={popoverMessage}>{emptyText}</p>}
              <button
                type="button"
                className={`${popoverOption} justify-start border-t border-[#f0eaf4] font-semibold text-[#6515b7] [&>svg]:text-[#8b54bc]`}
                onClick={() => confirmManualRegion()}
              >
                <Check size={16} />
                <span>{formatTypedRegion(query.trim())}</span>
              </button>
            </>
          )}
          <div className="border-t border-[#f0eaf4] px-[11px] pt-2 pb-1 text-right text-[10px] font-normal text-[#9993a0]">
            {attribution}{" "}
            <strong className="text-xs tracking-[-.02em] text-[#5f6368]">
              Google
            </strong>
          </div>
        </div>
      )}
    </div>
  );
}
