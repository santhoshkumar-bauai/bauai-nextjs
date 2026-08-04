"use client";

import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, MapPin, Search } from "lucide-react";

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

export function RegionAutocomplete({ locale, value, onChange, placeholder, searchingText, emptyText, attribution, formatTypedRegion }: RegionAutocompleteProps) {
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
        const response = await fetch(`/api/locations?${params}`, { signal: controller.signal });
        const result = await response.json() as { items?: RegionSuggestion[] };
        if (response.ok) setItems(result.items || []);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) setItems([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 380);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [locale, query, value?.label]);

  const select = async (item: RegionSuggestion) => {
    setResolving(true);
    try {
      const params = new URLSearchParams({ placeId: item.placeId, locale });
      const response = await fetch(`/api/locations/details?${params}`);
      const result = await response.json() as SelectedRegion;
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
    <div className="region-autocomplete" ref={rootRef}>
      <div className="onboarding-input region-control">
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
        {(loading || resolving) ? <LoaderCircle className="combobox-spinner" size={17} /> : value ? <Check className="region-check" size={17} /> : <Search size={16} />}
      </div>
      {open && query.trim().length >= 3 && query !== value?.label && (
        <div className="combobox-popover region-results" id="region-suggestions" role="listbox">
          {loading ? <p className="combobox-message"><LoaderCircle size={15} />{searchingText}</p> : (
            <>
              {items.map((item) => (
                <button type="button" role="option" aria-selected="false" key={item.placeId} onClick={() => select(item)}>
                  <MapPin size={16} />
                  <span><strong>{item.primary}</strong>{item.secondary && <small>{item.secondary}</small>}</span>
                </button>
              ))}
              {!items.length && <p className="combobox-message">{emptyText}</p>}
              <button type="button" className="region-manual-option" onClick={() => confirmManualRegion()}>
                <Check size={16} /><span>{formatTypedRegion(query.trim())}</span>
              </button>
            </>
          )}
          <div className="google-attribution">{attribution} <strong>Google</strong></div>
        </div>
      )}
    </div>
  );
}
