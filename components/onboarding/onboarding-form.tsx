"use client";

import { FormEvent, useCallback, useMemo, useState } from "react";
import { BriefcaseBusiness, CheckCircle2, Globe2, ListChecks, Sparkles, Tags } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import { LanguageSwitcher } from "@/components/language-switcher";
import { RegionAutocomplete, type SelectedRegion } from "@/components/onboarding/region-autocomplete";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MultiSelectCombobox, type ComboboxOption } from "@/components/ui/multi-select-combobox";
import { companyDomains, localizeOption, services as serviceCatalog } from "@/data/onboarding-catalog";
import { companyWebsitePattern } from "@/lib/validation/company-website";

export function OnboardingForm() {
  const t = useTranslations("Onboarding");
  const locale = useLocale();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [mapping, setMapping] = useState(false);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState(false);
  const [completionStatus, setCompletionStatus] = useState<"active" | "pending">("active");
  const [businessDomain, setBusinessDomain] = useState("");
  const [selectedServices, setSelectedServices] = useState<ComboboxOption[]>([]);
  const [selectedCpvCodes, setSelectedCpvCodes] = useState<ComboboxOption[]>([]);
  const [region, setRegion] = useState<SelectedRegion | null>(null);

  const domainOptions = useMemo(() => companyDomains.map((option) => ({
    value: option.value,
    label: localizeOption(option, locale),
  })), [locale]);
  const serviceOptions = useMemo(() => serviceCatalog.map((option) => ({
    value: localizeOption(option, locale),
    label: localizeOption(option, locale),
  })), [locale]);

  const loadCpvOptions = useCallback(async (query: string) => {
    const params = new URLSearchParams({ q: query, locale, domain: businessDomain });
    const response = await fetch(`/api/cpv-codes?${params}`);
    const result = await response.json() as { items?: ComboboxOption[] };
    return response.ok ? result.items || [] : [];
  }, [businessDomain, locale]);

  const mapCpvCodes = async () => {
    setError("");
    if (!selectedServices.length) {
      setError(t("servicesRequired"));
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
      const result = await response.json() as { items?: ComboboxOption[]; error?: string };
      if (!response.ok || !result.items) {
        setError(result.error || t("cpvMapError"));
        return;
      }
      setSelectedCpvCodes(result.items);
    } finally {
      setMapping(false);
    }
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!region) {
      setError(t("regionRequired"));
      return;
    }
    if (!selectedServices.length) {
      setError(t("servicesRequired"));
      return;
    }
    if (!selectedCpvCodes.length) {
      setError(t("cpvRequired"));
      return;
    }

    setLoading(true);
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/onboarding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        website: String(form.get("website") ?? ""),
        businessDomain,
        region: region.label,
        ...(region.placeId ? { regionPlaceId: region.placeId } : {}),
        ...(typeof region.latitude === "number" ? { latitude: region.latitude } : {}),
        ...(typeof region.longitude === "number" ? { longitude: region.longitude } : {}),
        services: selectedServices.map((item) => item.label),
        cpvCodes: selectedCpvCodes.map((item) => item.value),
        locale,
      }),
    });

    const result = await response.json() as { error?: string; membershipStatus?: "active" | "pending" };
    if (!response.ok) {
      setError(result.error || t("error"));
      setLoading(false);
      return;
    }

    setCompletionStatus(result.membershipStatus === "pending" ? "pending" : "active");
    setCompleted(true);
    window.setTimeout(() => {
      router.replace("/dashboard");
      router.refresh();
    }, 1300);
  }

  if (completed) {
    return (
      <section className="onboarding-complete" aria-live="polite">
        <span><CheckCircle2 size={42} /></span>
        <h1>{completionStatus === "pending" ? t("pendingTitle") : t("completeTitle")}</h1>
        <p>{completionStatus === "pending" ? t("pendingDescription") : t("completeDescription")}</p>
      </section>
    );
  }

  return (
    <form className="onboarding-card-main" onSubmit={submit}>
      <header className="onboarding-page-heading">
        <div><h1>{t("title")}</h1><p>{t("description")}</p></div>
        <LanguageSwitcher />
      </header>

      <label className="onboarding-field">
        <span>{t("website")} <b>*</b></span>
        <span className="onboarding-input"><Globe2 size={18} /><Input name="website" placeholder={t("websitePlaceholder")} pattern={companyWebsitePattern.source} title={t("websiteError")} required /></span>
        <small>{t("websiteHint")}</small>
      </label>

      <label className="onboarding-field">
        <span>{t("businessDomain")} <b>*</b></span>
        <span className="onboarding-input"><BriefcaseBusiness size={18} />
          <select value={businessDomain} onChange={(event) => setBusinessDomain(event.target.value)} required>
            <option value="" disabled>{t("businessDomainPlaceholder")}</option>
            {domainOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select>
        </span>
      </label>

      <div className="onboarding-field">
        <span>{t("region")} <b>*</b></span>
        <RegionAutocomplete
          locale={locale}
          value={region}
          onChange={setRegion}
          placeholder={t("regionPlaceholder")}
          searchingText={t("regionSearching")}
          emptyText={t("regionEmpty")}
          attribution={t("poweredBy")}
          formatTypedRegion={(value) => t("useTypedRegion", { value })}
        />
        <small>{t("regionHint")}</small>
      </div>

      <div className="onboarding-field">
        <span>{t("services")} <b>*</b></span>
        <div className="field-with-icon"><Tags size={18} />
          <MultiSelectCombobox
            value={selectedServices}
            onChange={setSelectedServices}
            options={serviceOptions}
            placeholder={t("servicesPlaceholder")}
            emptyText={t("servicesEmpty")}
            loadingText={t("loading")}
            addText={(value) => t("addService", { value })}
            allowCustom
            ariaLabel={t("services")}
          />
        </div>
        <small>{t("servicesHint")}</small>
      </div>

      <div className="onboarding-field">
        <span className="field-title-action"><span>{t("cpvCodes")} <b>*</b></span><button type="button" onClick={mapCpvCodes} disabled={mapping || !selectedServices.length}><Sparkles size={15} />{mapping ? t("mappingCpv") : t("autoMapCpv")}</button></span>
        <div className="field-with-icon"><ListChecks size={18} />
          <MultiSelectCombobox
            key={`${locale}-${businessDomain}`}
            value={selectedCpvCodes}
            onChange={setSelectedCpvCodes}
            loadOptions={loadCpvOptions}
            placeholder={t("cpvPlaceholder")}
            emptyText={t("cpvEmpty")}
            loadingText={t("loadingCpv")}
            ariaLabel={t("cpvCodes")}
          />
        </div>
        <small>{t("cpvHint")}</small>
      </div>

      <div className="trial-callout"><CheckCircle2 size={18} /><div><strong>{t("trialTitle")}</strong><span>{t("trialDescription")}</span></div></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <Button type="submit" size="lg" className="onboarding-submit" disabled={loading}>{loading ? t("submitting") : t("submit")}</Button>
    </form>
  );
}
