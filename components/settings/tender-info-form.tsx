"use client";

import { Sparkles } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import {
  RegionAutocomplete,
  type SelectedRegion,
} from "@/components/onboarding/region-autocomplete";
import {
  card,
  fieldInput,
  fieldLabel,
  primaryButton,
} from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import {
  MultiSelectCombobox,
  type ComboboxOption,
} from "@/components/ui/multi-select-combobox";
import {
  companyDomains,
  localizeOption,
  services as serviceCatalog,
} from "@/data/onboarding-catalog";
import type { SerializedCompanyProfile } from "@/lib/company/serialize";

function toOptions(values: string[] | undefined): ComboboxOption[] {
  return (values ?? []).map((value) => ({ value, label: value }));
}

/**
 * Tender-information section, wired to the same data sources as onboarding:
 * business domains and services from the catalog, region from the Places
 * autocomplete, CPV codes from catalog search plus the AI mapper.
 */
export function TenderInfoForm({
  profile,
  canEdit,
}: {
  profile: SerializedCompanyProfile;
  canEdit: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("Settings");
  const tOnboarding = useTranslations("Onboarding");
  const locale = useLocale();

  const [businessDomain, setBusinessDomain] = useState(
    profile.businessDomain ?? "",
  );
  const [region, setRegion] = useState<SelectedRegion | null>(
    profile.region ? { label: profile.region } : null,
  );
  const [regionTouched, setRegionTouched] = useState(false);
  const [selectedServices, setSelectedServices] = useState<ComboboxOption[]>(
    toOptions(profile.services),
  );
  const [selectedCpvCodes, setSelectedCpvCodes] = useState<ComboboxOption[]>(
    toOptions(profile.cpvCodes),
  );
  const [trade, setTrade] = useState<ComboboxOption[]>(toOptions(profile.trade));
  const [specializations, setSpecializations] = useState<ComboboxOption[]>(
    toOptions(profile.specializations),
  );
  const [certifications, setCertifications] = useState<ComboboxOption[]>(
    toOptions(profile.certifications),
  );

  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [mapping, setMapping] = useState(false);
  const [error, setError] = useState("");

  const domainOptions = useMemo(
    () =>
      companyDomains.map((option) => ({
        value: option.value,
        label: localizeOption(option, locale),
      })),
    [locale],
  );
  const serviceOptions = useMemo(
    () =>
      serviceCatalog.map((option) => ({
        value: localizeOption(option, locale),
        label: localizeOption(option, locale),
      })),
    [locale],
  );

  const loadCpvOptions = useCallback(
    async (query: string) => {
      const params = new URLSearchParams({
        q: query,
        locale,
        domain: businessDomain,
      });
      const response = await fetch(`/api/cpv-codes?${params}`);
      const result = (await response.json()) as { items?: ComboboxOption[] };
      return response.ok ? result.items || [] : [];
    },
    [businessDomain, locale],
  );

  const mapCpvCodes = async () => {
    setError("");
    if (!selectedServices.length) {
      setError(tOnboarding("servicesRequired"));
      return;
    }
    setMapping(true);
    try {
      const response = await fetch("/api/cpv-map", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          services: selectedServices.map((item) => item.label),
          businessDomain,
          locale,
        }),
      });
      const result = (await response.json()) as {
        items?: ComboboxOption[];
        error?: string;
      };
      if (!response.ok || !result.items) {
        setError(result.error || tOnboarding("cpvMapError"));
        return;
      }
      setSelectedCpvCodes(result.items);
      setStatus("idle");
    } finally {
      setMapping(false);
    }
  };

  const initialSnapshot = useMemo(
    () =>
      JSON.stringify({
        businessDomain: profile.businessDomain ?? "",
        region: profile.region ?? "",
        services: profile.services ?? [],
        cpvCodes: profile.cpvCodes ?? [],
        trade: profile.trade ?? [],
        specializations: profile.specializations ?? [],
        certifications: profile.certifications ?? [],
      }),
    [profile],
  );
  const currentSnapshot = JSON.stringify({
    businessDomain,
    region: region?.label ?? "",
    services: selectedServices.map((item) => item.value),
    cpvCodes: selectedCpvCodes.map((item) => item.value),
    trade: trade.map((item) => item.value),
    specializations: specializations.map((item) => item.value),
    certifications: certifications.map((item) => item.value),
  });
  const dirty = currentSnapshot !== initialSnapshot;

  const save = async () => {
    setStatus("saving");
    setError("");
    try {
      const body: Record<string, unknown> = {
        businessDomain,
        region: region?.label ?? "",
        services: selectedServices.map((item) => item.value),
        cpvCodes: selectedCpvCodes.map((item) => item.value),
        trade: trade.map((item) => item.value),
        specializations: specializations.map((item) => item.value),
        certifications: certifications.map((item) => item.value),
      };
      // Only send coordinates when the user actually picked a new place —
      // otherwise the stored onboarding location must stay untouched.
      if (regionTouched && region?.placeId) {
        body.regionLocation = {
          placeId: region.placeId,
          latitude: region.latitude,
          longitude: region.longitude,
        };
      }
      const response = await fetch("/api/company/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error || t("feedback.saveFailed"));
      }
      setStatus("saved");
      router.refresh();
    } catch (saveError) {
      setStatus("error");
      setError(
        saveError instanceof Error ? saveError.message : t("feedback.saveFailed"),
      );
    }
  };

  return (
    <section className={`${card} p-5 sm:p-[26px]`}>
      <h2 className="m-0 text-base font-bold tracking-[-.02em]">
        {t("sections.tenderInfo.title")}
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-[#85818c]">
        {t("sections.tenderInfo.description")}
      </p>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className={fieldLabel}>
          <span>{t("sections.tenderInfo.fields.businessDomain")}</span>
          <select
            value={businessDomain}
            disabled={!canEdit}
            onChange={(event) => {
              setBusinessDomain(event.target.value);
              setStatus("idle");
            }}
            className={fieldInput}
          >
            <option value="">
              {tOnboarding("businessDomainPlaceholder")}
            </option>
            {domainOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <div className={fieldLabel}>
          <span>{t("sections.tenderInfo.fields.region")}</span>
          <RegionAutocomplete
            locale={locale}
            value={region}
            onChange={(next) => {
              setRegion(next);
              setRegionTouched(true);
              setStatus("idle");
            }}
            placeholder={tOnboarding("regionPlaceholder")}
            searchingText={tOnboarding("regionSearching")}
            emptyText={tOnboarding("regionEmpty")}
            attribution={tOnboarding("poweredBy")}
            formatTypedRegion={(value) => tOnboarding("useTypedRegion", { value })}
            required={false}
            disabled={!canEdit}
          />
        </div>
      </div>

      <div className="mt-4 grid gap-4">
        <div className={fieldLabel}>
          <span>{t("sections.tenderInfo.fields.services")}</span>
          <MultiSelectCombobox
            value={selectedServices}
            onChange={(next) => {
              setSelectedServices(next);
              setStatus("idle");
            }}
            options={serviceOptions}
            allowCustom
            placeholder={tOnboarding("servicesPlaceholder")}
            emptyText={tOnboarding("servicesEmpty")}
            loadingText={tOnboarding("loading")}
            addText={(value) => tOnboarding("addService", { value })}
            disabled={!canEdit}
            ariaLabel={t("sections.tenderInfo.fields.services")}
          />
        </div>

        <div className={fieldLabel}>
          <span className="flex items-center justify-between gap-2">
            {t("sections.tenderInfo.fields.cpvCodes")}
            {canEdit && (
              <button
                type="button"
                onClick={mapCpvCodes}
                disabled={mapping || !selectedServices.length}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-[#6516dc] hover:underline disabled:opacity-50"
              >
                <Sparkles className="size-3" />
                {mapping ? tOnboarding("mappingCpv") : tOnboarding("autoMapCpv")}
              </button>
            )}
          </span>
          <MultiSelectCombobox
            key={`${locale}-${businessDomain}`}
            value={selectedCpvCodes}
            onChange={(next) => {
              setSelectedCpvCodes(next);
              setStatus("idle");
            }}
            loadOptions={loadCpvOptions}
            placeholder={tOnboarding("cpvPlaceholder")}
            emptyText={tOnboarding("cpvEmpty")}
            loadingText={tOnboarding("loadingCpv")}
            disabled={!canEdit}
            ariaLabel={t("sections.tenderInfo.fields.cpvCodes")}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {(
            [
              ["trade", trade, setTrade],
              ["specializations", specializations, setSpecializations],
            ] as const
          ).map(([key, value, setValue]) => (
            <div key={key} className={fieldLabel}>
              <span>{t(`sections.tenderInfo.fields.${key}`)}</span>
              <MultiSelectCombobox
                value={value}
                onChange={(next) => {
                  setValue(next);
                  setStatus("idle");
                }}
                options={[]}
                allowCustom
                placeholder={t(`sections.tenderInfo.fields.${key}`)}
                emptyText={tOnboarding("servicesEmpty")}
                loadingText={tOnboarding("loading")}
                addText={(entry) => tOnboarding("addService", { value: entry })}
                disabled={!canEdit}
                ariaLabel={t(`sections.tenderInfo.fields.${key}`)}
              />
            </div>
          ))}
        </div>

        <div className={fieldLabel}>
          <span>{t("sections.tenderInfo.fields.certifications")}</span>
          <MultiSelectCombobox
            value={certifications}
            onChange={(next) => {
              setCertifications(next);
              setStatus("idle");
            }}
            options={[]}
            allowCustom
            placeholder={t("sections.tenderInfo.fields.certifications")}
            emptyText={tOnboarding("servicesEmpty")}
            loadingText={tOnboarding("loading")}
            addText={(entry) => tOnboarding("addService", { value: entry })}
            disabled={!canEdit}
            ariaLabel={t("sections.tenderInfo.fields.certifications")}
          />
        </div>
      </div>

      {canEdit && (
        <div className="mt-5 flex items-center gap-3">
          {status === "saved" && !dirty && (
            <span className="text-[11px] font-semibold text-[#0b8b4b]">
              {t("actions.saved")}
            </span>
          )}
          {(status === "error" || error) && (
            <span className="text-[11px] font-semibold text-[#c02626]">
              {error}
            </span>
          )}
          <Button
            type="button"
            onClick={save}
            disabled={!dirty || status === "saving"}
            className={`ml-auto ${primaryButton}`}
          >
            {status === "saving" ? t("actions.saving") : t("actions.save")}
          </Button>
        </div>
      )}
    </section>
  );
}
