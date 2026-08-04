"use client";

import { FormEvent, useState } from "react";
import { BriefcaseBusiness, CheckCircle2, Globe2, ListChecks, MapPin, Tags } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import { LanguageSwitcher } from "@/components/language-switcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { companyWebsitePattern } from "@/lib/validation/company-website";

const splitList = (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean);

export function OnboardingForm() {
  const t = useTranslations("Onboarding");
  const locale = useLocale();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);
    const form = new FormData(event.currentTarget);

    const response = await fetch("/api/onboarding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        website: String(form.get("website") ?? ""),
        businessDomain: String(form.get("businessDomain") ?? ""),
        region: String(form.get("region") ?? ""),
        services: splitList(String(form.get("services") ?? "")),
        cpvCodes: splitList(String(form.get("cpvCodes") ?? "")),
        locale,
      }),
    });

    const result = await response.json();
    if (!response.ok) {
      setError(result.error || t("error"));
      setLoading(false);
      return;
    }

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
        <h1>{t("completeTitle")}</h1>
        <p>{t("completeDescription")}</p>
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
          <select name="businessDomain" defaultValue="" required>
            <option value="" disabled>{t("businessDomainPlaceholder")}</option>
            <option value="construction">{t("domains.construction")}</option>
            <option value="engineering">{t("domains.engineering")}</option>
            <option value="architecture">{t("domains.architecture")}</option>
            <option value="supplier">{t("domains.supplier")}</option>
            <option value="other">{t("domains.other")}</option>
          </select>
        </span>
      </label>

      <label className="onboarding-field">
        <span>{t("region")} <b>*</b></span>
        <span className="onboarding-input"><MapPin size={18} /><Input name="region" placeholder={t("regionPlaceholder")} required /></span>
      </label>

      <label className="onboarding-field">
        <span>{t("services")} <b>*</b></span>
        <span className="onboarding-input"><Tags size={18} /><Input name="services" placeholder={t("servicesPlaceholder")} required /></span>
        <small>{t("servicesHint")}</small>
      </label>

      <label className="onboarding-field">
        <span>{t("cpvCodes")} <b>*</b></span>
        <span className="onboarding-input"><ListChecks size={18} /><Input name="cpvCodes" placeholder={t("cpvPlaceholder")} required /></span>
        <small>{t("cpvHint")}</small>
      </label>

      <div className="trial-callout"><CheckCircle2 size={18} /><div><strong>{t("trialTitle")}</strong><span>{t("trialDescription")}</span></div></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <Button type="submit" size="lg" className="onboarding-submit" disabled={loading}>{loading ? t("submitting") : t("submit")}</Button>
    </form>
  );
}
