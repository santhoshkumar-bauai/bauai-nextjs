"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { TagInput } from "@/components/settings/tag-input";
import {
  card,
  fieldInput,
  fieldLabel,
  primaryButton,
} from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import type { SerializedCompanyProfile } from "@/lib/company/serialize";
import type { SectionConfig } from "@/lib/company/settings-sections";

type FieldValue = string | string[];

/** Reads the current value of a field from the profile for a given section group. */
function readValue(
  profile: SerializedCompanyProfile,
  group: SectionConfig["group"],
  key: string,
): FieldValue {
  if (group === "root") {
    const value = (profile as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value as string[];
    if (value === null || value === undefined) return "";
    return String(value);
  }
  if (group === "bankDetails") return profile.bankDetails?.[key as keyof typeof profile.bankDetails] ?? "";
  if (group === "projectSizeRange")
    return profile.projectSizeRange?.[key as keyof typeof profile.projectSizeRange] ?? "";
  const kb = profile.knowledgeBase as Record<string, unknown> | undefined;
  const section = kb?.[group] as Record<string, unknown> | undefined;
  const value = section?.[key];
  return value === null || value === undefined ? "" : String(value);
}

/**
 * A self-contained editable card for one profile section. Handles both top-level
 * company fields and nested knowledge-base / bankDetails / projectSizeRange
 * slices, and persists via `PATCH /api/company/profile`. KB and nested-object
 * sections are merged with the current profile so saving one section never wipes
 * another.
 */
export function SectionForm({
  profile,
  config,
  canEdit,
}: {
  profile: SerializedCompanyProfile;
  config: SectionConfig;
  canEdit: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("Settings");
  const initial = useMemo(() => {
    const state: Record<string, FieldValue> = {};
    for (const field of config.fields) {
      state[field.key] = readValue(profile, config.group, field.key);
    }
    return state;
  }, [profile, config]);

  const [values, setValues] = useState<Record<string, FieldValue>>(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [error, setError] = useState("");

  const dirty = useMemo(
    () => JSON.stringify(values) !== JSON.stringify(initial),
    [values, initial],
  );

  const setField = (key: string, value: FieldValue) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setStatus("idle");
  };

  const buildBody = (): Record<string, unknown> => {
    const { group } = config;
    if (group === "root") {
      const body: Record<string, unknown> = {};
      for (const field of config.fields) {
        const value = values[field.key];
        if (field.type === "number") {
          body[field.key] =
            typeof value === "string" && value.trim() ? Number(value) : null;
        } else {
          body[field.key] = value;
        }
      }
      return body;
    }
    // Object-valued groups: send the whole sub-object.
    const sub: Record<string, unknown> = {};
    for (const field of config.fields) sub[field.key] = values[field.key];
    if (group === "bankDetails") return { bankDetails: sub };
    if (group === "projectSizeRange") return { projectSizeRange: sub };
    // knowledgeBase: merge with existing sections so we don't drop the others.
    return {
      knowledgeBase: { ...(profile.knowledgeBase ?? {}), [group]: sub },
    };
  };

  const save = async () => {
    setStatus("saving");
    setError("");
    try {
      const response = await fetch("/api/company/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error || `Save failed (${response.status}).`);
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
    <section data-tour="company-profile-form" className={`${card} p-5 sm:p-[26px]`}>
      <h2 className="m-0 text-base font-bold tracking-[-.02em]">
        {t(`sections.${config.id}.title`)}
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-[#85818c]">
        {t(`sections.${config.id}.description`)}
      </p>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        {config.fields.map((field) => {
          const value = values[field.key];
          const isWide = field.type === "textarea" || field.type === "tags";
          return (
            <label
              key={field.key}
              className={`${fieldLabel} ${isWide ? "sm:col-span-2" : ""}`}
            >
              <span>{t(`sections.${config.id}.fields.${field.key}`)}</span>
              {field.type === "tags" ? (
                <TagInput
                  value={Array.isArray(value) ? value : []}
                  onChange={(next) => setField(field.key, next)}
                  placeholder={t("actions.tagHint")}
                  disabled={!canEdit}
                />
              ) : field.type === "textarea" ? (
                <textarea
                  value={typeof value === "string" ? value : ""}
                  onChange={(event) => setField(field.key, event.target.value)}
                  placeholder={field.sample}
                  disabled={!canEdit}
                  className={`${fieldInput} min-h-[96px] resize-y`}
                />
              ) : (
                <input
                  type={field.type === "number" ? "number" : field.type === "date" ? "date" : field.type === "email" ? "email" : "text"}
                  value={typeof value === "string" ? value : ""}
                  onChange={(event) => setField(field.key, event.target.value)}
                  placeholder={field.sample}
                  disabled={!canEdit}
                  className={fieldInput}
                />
              )}
            </label>
          );
        })}
      </div>
      {canEdit && (
        <div className="mt-5 flex items-center gap-3">
          {status === "saved" && !dirty && (
            <span className="text-[11px] font-semibold text-[#0b8b4b]">
              {t("actions.saved")}
            </span>
          )}
          {status === "error" && (
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
