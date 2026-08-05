"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import {
  card,
  fieldInput,
  fieldLabel,
  primaryButton,
} from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import type { SerializedCompanyProfile } from "@/lib/company/serialize";
import { CERTIFICATION_FLAGS } from "@/lib/company/settings-sections";

type CertState = Record<string, boolean | string>;

/**
 * The business-certifications section — a grid of boolean flags plus a free-text
 * "other" field, persisted into knowledgeBase.businessCertifications.
 */
export function CertificationsForm({
  profile,
  canEdit,
}: {
  profile: SerializedCompanyProfile;
  canEdit: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("Settings");
  const initial = useMemo<CertState>(() => {
    const current =
      (profile.knowledgeBase?.businessCertifications as
        | Record<string, unknown>
        | undefined) ?? {};
    const state: CertState = {};
    for (const flag of CERTIFICATION_FLAGS) {
      state[flag] = current[flag] === true;
    }
    state.otherCertifications =
      typeof current.otherCertifications === "string"
        ? current.otherCertifications
        : "";
    return state;
  }, [profile]);

  const [values, setValues] = useState<CertState>(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [error, setError] = useState("");
  const dirty = useMemo(
    () => JSON.stringify(values) !== JSON.stringify(initial),
    [values, initial],
  );

  const save = async () => {
    setStatus("saving");
    setError("");
    try {
      const response = await fetch("/api/company/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          knowledgeBase: {
            ...(profile.knowledgeBase ?? {}),
            businessCertifications: values,
          },
        }),
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
        {t("sections.certifications.title")}
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-[#85818c]">
        {t("sections.certifications.description")}
      </p>
      <div className="mt-5 grid gap-2.5 sm:grid-cols-2">
        {CERTIFICATION_FLAGS.map((flag) => (
          <label
            key={flag}
            className="flex items-center gap-2.5 rounded-[9px] border border-[#eceaf2] px-3 py-2.5 text-xs text-[#29262e]"
          >
            <input
              type="checkbox"
              checked={values[flag] === true}
              disabled={!canEdit}
              onChange={(event) => {
                setValues((prev) => ({ ...prev, [flag]: event.target.checked }));
                setStatus("idle");
              }}
              className="size-4 accent-[#6516dc]"
            />
            {t(`certificationFlags.${flag}`)}
          </label>
        ))}
      </div>
      <label className={`${fieldLabel} mt-4`}>
        <span>{t("sections.certifications.other")}</span>
        <input
          value={typeof values.otherCertifications === "string" ? values.otherCertifications : ""}
          disabled={!canEdit}
          placeholder="ISO 9001, ISO 14001"
          onChange={(event) => {
            setValues((prev) => ({ ...prev, otherCertifications: event.target.value }));
            setStatus("idle");
          }}
          className={fieldInput}
        />
      </label>
      {canEdit && (
        <div className="mt-5 flex items-center gap-3">
          {status === "saved" && !dirty && (
            <span className="text-[11px] font-semibold text-[#0b8b4b]">
              {t("actions.saved")}
            </span>
          )}
          {status === "error" && (
            <span className="text-[11px] font-semibold text-[#c02626]">{error}</span>
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
