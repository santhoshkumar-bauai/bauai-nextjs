"use client";

import { Loader2, MapPin } from "lucide-react";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import {
  RegionAutocomplete,
  type SelectedRegion,
} from "@/components/onboarding/region-autocomplete";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * Changes the company's region from the tenders toolbar. The region drives the
 * geo half of the relevance score *and* the "X km away" hints, so saving it
 * persists to the company record and then forces the list to re-rank.
 *
 * Only company admins may write the profile — a 403 surfaces as an inline
 * message instead of silently doing nothing.
 */
export function RegionSwitcher({
  region,
  onSaved,
}: {
  region: string | null;
  onSaved: (region: string) => void;
}) {
  // `Tenders.region` is the NUTS label map — this picker's copy lives apart.
  const t = useTranslations("Tenders.regionPicker");
  // Reuses the onboarding/settings Places picker, and its copy with it.
  const ta = useTranslations("Onboarding");
  const locale = useLocale();

  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<SelectedRegion | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!selected || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/company/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          region: selected.label,
          regionLocation:
            selected.placeId &&
            typeof selected.latitude === "number" &&
            typeof selected.longitude === "number"
              ? {
                  placeId: selected.placeId,
                  latitude: selected.latitude,
                  longitude: selected.longitude,
                }
              : null,
        }),
      });
      if (response.status === 403) {
        setError(t("forbidden"));
        return;
      }
      if (!response.ok) {
        setError(t("error"));
        return;
      }
      onSaved(selected.label);
      setSelected(null);
      setOpen(false);
    } catch {
      setError(t("error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-100 data-[popup-open]:bg-emerald-100">
        <MapPin className="size-3.5" />
        <span className="max-w-[140px] truncate">{region ?? t("unset")}</span>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80 p-3">
        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {t("change")}
          </span>
          <p className="text-[11px] text-muted-foreground">{t("hint")}</p>

          <RegionAutocomplete
            locale={locale}
            value={selected}
            onChange={setSelected}
            placeholder={ta("regionPlaceholder")}
            searchingText={ta("regionSearching")}
            emptyText={ta("regionEmpty")}
            attribution={ta("poweredBy")}
            formatTypedRegion={(value) => ta("useTypedRegion", { value })}
            required={false}
            disabled={saving}
          />

          {error && <p className="text-[11px] text-red-600">{error}</p>}

          <button
            type="button"
            onClick={save}
            disabled={!selected || saving}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
          >
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            {t("save")}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
