"use client";

import { Bookmark, ChevronDown, Loader2, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { TenderFilters } from "@/lib/tenders/filters";

interface SavedPreset {
  id: string;
  name: string;
  filters: TenderFilters;
  createdAt: string | null;
}

export function SavedFilters({
  currentFilters,
  onApply,
}: {
  currentFilters: TenderFilters;
  onApply: (filters: TenderFilters) => void;
}) {
  const t = useTranslations("Tenders");
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SavedPreset[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || loaded) return;
    const controller = new AbortController();
    fetch("/api/tenders/saved-filters", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((json: { items?: SavedPreset[] }) => {
        setItems(json.items ?? []);
        setLoaded(true);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [open, loaded]);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const response = await fetch("/api/tenders/saved-filters", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed, filters: currentFilters }),
      });
      const json = (await response.json()) as { savedFilter?: SavedPreset };
      if (response.ok && json.savedFilter) {
        setItems((prev) => [json.savedFilter as SavedPreset, ...prev]);
        setName("");
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setItems((prev) => prev.filter((preset) => preset.id !== id));
    await fetch(`/api/tenders/saved-filters/${id}`, { method: "DELETE" }).catch(
      () => undefined,
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted data-[popup-open]:bg-muted">
        <Bookmark className="size-3.5 text-muted-foreground" />
        {t("saved.button")}
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </PopoverTrigger>

      <PopoverContent align="end" className="w-64">
        <div className="mb-2 flex items-center gap-1.5">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") save();
            }}
            placeholder={t("saved.namePlaceholder")}
            maxLength={60}
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring"
          />
          <button
            type="button"
            onClick={save}
            disabled={!name.trim() || saving}
            title={t("saved.save")}
            className="grid size-8 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
          >
            {saving ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Plus className="size-3.5" />
            )}
          </button>
        </div>

        <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {items.length === 0 ? (
            <p className="px-2 py-4 text-center text-[11px] text-muted-foreground">
              {t("saved.empty")}
            </p>
          ) : (
            items.map((preset) => (
              <div
                key={preset.id}
                className="group flex items-center gap-1 rounded-md hover:bg-muted"
              >
                <button
                  type="button"
                  onClick={() => {
                    onApply(preset.filters);
                    setOpen(false);
                  }}
                  className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs text-foreground"
                >
                  {preset.name}
                </button>
                <button
                  type="button"
                  onClick={() => remove(preset.id)}
                  title={t("saved.delete")}
                  className="mr-1 grid size-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-600"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
