"use client";

import { FormEvent, useCallback, useMemo, useState } from "react";
import {
  BriefcaseBusiness,
  CheckCircle2,
  Globe2,
  ListChecks,
  Sparkles,
  Tags,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import { LanguageSwitcher } from "@/components/language-switcher";
import {
  RegionAutocomplete,
  type SelectedRegion,
} from "@/components/onboarding/region-autocomplete";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MultiSelectCombobox,
  type ComboboxOption,
} from "@/components/ui/multi-select-combobox";
import {
  companyDomains,
  localizeOption,
  services as serviceCatalog,
} from "@/data/onboarding-catalog";
import { companyWebsitePattern } from "@/lib/validation/company-website";
import { authError } from "@/components/auth/auth-tailwind";
import {
  fieldWithIcon,
  onboardingCard,
  onboardingField,
  onboardingInput,
} from "./onboarding-tailwind";

export function OnboardingForm() {
  const t = useTranslations("Onboarding");
  const locale = useLocale();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [mapping, setMapping] = useState(false);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState(false);
  const [completionStatus, setCompletionStatus] = useState<
    "active" | "pending"
  >("active");
  const [businessDomain, setBusinessDomain] = useState("");
  const [selectedServices, setSelectedServices] = useState<ComboboxOption[]>(
    [],
  );
  const [selectedCpvCodes, setSelectedCpvCodes] = useState<ComboboxOption[]>(
    [],
  );
  const [region, setRegion] = useState<SelectedRegion | null>(null);

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
      const result = (await response.json()) as {
        items?: ComboboxOption[];
        error?: string;
      };
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
        ...(typeof region.latitude === "number"
          ? { latitude: region.latitude }
          : {}),
        ...(typeof region.longitude === "number"
          ? { longitude: region.longitude }
          : {}),
        services: selectedServices.map((item) => item.label),
        cpvCodes: selectedCpvCodes.map((item) => item.value),
        locale,
      }),
    });

    const result = (await response.json()) as {
      error?: string;
      membershipStatus?: "active" | "pending";
    };
    if (!response.ok) {
      setError(result.error || t("error"));
      setLoading(false);
      return;
    }

    setCompletionStatus(
      result.membershipStatus === "pending" ? "pending" : "active",
    );
    setCompleted(true);
    window.setTimeout(() => {
      router.replace("/dashboard");
      router.refresh();
    }, 1300);
  }

  if (completed) {
    return (
      <section
        className="w-[min(100%,480px)] rounded-[22px] border border-[#e7e1eb] bg-white p-11 text-center shadow-[0_30px_80px_rgba(46,22,73,.14)]"
        aria-live="polite"
      >
        <span className="mx-auto grid size-[76px] place-items-center rounded-full bg-[#eafaf0] text-[#18864b]">
          <CheckCircle2 size={42} />
        </span>
        <h1 className="mt-[22px] mb-2 text-2xl font-bold">
          {completionStatus === "pending"
            ? t("pendingTitle")
            : t("completeTitle")}
        </h1>
        <p className="m-0 leading-[1.6] text-[#6e6875]">
          {completionStatus === "pending"
            ? t("pendingDescription")
            : t("completeDescription")}
        </p>
      </section>
    );
  }

  return (
    <form className={onboardingCard} onSubmit={submit}>
      <header className="mb-[30px] flex items-start justify-between gap-5 max-[560px]:grid">
        <div>
          <h1 className="m-0 text-[27px] font-bold tracking-[-.04em]">
            {t("title")}
          </h1>
          <p className="mt-[9px] mb-0 max-w-[520px] text-sm leading-[1.55] text-[#6e6875]">
            {t("description")}
          </p>
        </div>
        <LanguageSwitcher />
      </header>

      <label className={onboardingField}>
        <span>
          {t("website")} <b>*</b>
        </span>
        <span className={onboardingInput}>
          <Globe2 size={18} />
          <Input
            name="website"
            placeholder={t("websitePlaceholder")}
            pattern={companyWebsitePattern.source}
            title={t("websiteError")}
            required
          />
        </span>
        <small>{t("websiteHint")}</small>
      </label>

      <label className={onboardingField}>
        <span>
          {t("businessDomain")} <b>*</b>
        </span>
        <span className={onboardingInput}>
          <BriefcaseBusiness size={18} />
          <select
            value={businessDomain}
            onChange={(event) => setBusinessDomain(event.target.value)}
            required
          >
            <option value="" disabled>
              {t("businessDomainPlaceholder")}
            </option>
            {domainOptions.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </span>
      </label>

      <div className={onboardingField}>
        <span>
          {t("region")} <b>*</b>
        </span>
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

      <div className={onboardingField}>
        <span>
          {t("services")} <b>*</b>
        </span>
        <div className={fieldWithIcon}>
          <Tags size={18} />
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

      <div className={onboardingField}>
        <span className="flex items-center justify-between gap-4">
          <span>
            {t("cpvCodes")} <b>*</b>
          </span>
          <button
            className="inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent text-xs font-semibold text-[#7522c5] hover:text-[#5000a8] disabled:cursor-not-allowed disabled:text-[#aaa4b1]"
            type="button"
            onClick={mapCpvCodes}
            disabled={mapping || !selectedServices.length}
          >
            <Sparkles size={15} />
            {mapping ? t("mappingCpv") : t("autoMapCpv")}
          </button>
        </span>
        <div className={fieldWithIcon}>
          <ListChecks size={18} />
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

      <div className="mt-[25px] flex gap-[11px] rounded-xl border border-[#e1d0f2] bg-[#faf6ff] p-[15px] text-[#6515b7]">
        <CheckCircle2 size={18} />
        <div className="grid gap-1">
          <strong className="text-[13px]">{t("trialTitle")}</strong>
          <span className="text-xs leading-[1.45] text-[#756c7e]">
            {t("trialDescription")}
          </span>
        </div>
      </div>
      {error && (
        <p className={authError} role="alert">
          {error}
        </p>
      )}
      <Button
        type="submit"
        size="lg"
        className="mt-6 h-12 w-full rounded-[10px] bg-[linear-gradient(135deg,#8d0bea,#5a00ad)] text-white shadow-[0_10px_22px_rgba(93,0,177,.2)] hover:bg-[linear-gradient(135deg,#9a18f2,#6600c1)]"
        disabled={loading}
      >
        {loading ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
