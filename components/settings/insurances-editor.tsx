"use client";

import { Plus, Trash2 } from "lucide-react";
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

type Insurance = { type: string; amount: string; details?: string };

/** Editor for the company-level insurances array (Company.insurances). */
export function InsurancesEditor({
  profile,
  canEdit,
}: {
  profile: SerializedCompanyProfile;
  canEdit: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("Settings");
  const initial = useMemo<Insurance[]>(
    () => (profile.insurances ?? []).map((item) => ({ ...item })),
    [profile],
  );
  const [rows, setRows] = useState<Insurance[]>(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const dirty = useMemo(
    () => JSON.stringify(rows) !== JSON.stringify(initial),
    [rows, initial],
  );

  const setRow = (index: number, patch: Partial<Insurance>) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    setStatus("idle");
  };

  const save = async () => {
    setStatus("saving");
    setError("");
    try {
      const cleaned = rows.filter((row) => row.type.trim() && row.amount.trim());
      const response = await fetch("/api/company/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ insurances: cleaned }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
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
    <section className={`${card} p-5 sm:p-[26px]`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="m-0 text-base font-bold tracking-[-.02em]">
            {t("sections.insurancePolicies.title")}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-[#85818c]">
            {t("sections.insurancePolicies.description")}
          </p>
        </div>
        {canEdit && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setRows((prev) => [...prev, { type: "", amount: "", details: "" }]);
              setStatus("idle");
            }}
          >
            <Plus size={14} />
            {t("actions.add")}
          </Button>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="mt-4 text-xs text-[#a29eaa]">
          {t("sections.insurancePolicies.empty")}
        </p>
      ) : (
        <div className="mt-4 grid gap-4">
          {rows.map((row, index) => (
            <div
              key={index}
              className="grid gap-3 rounded-[12px] border border-[#eceaf2] p-3.5 sm:grid-cols-[1fr_1fr_auto]"
            >
              <label className={fieldLabel}>
                <span>{t("sections.insurancePolicies.type")}</span>
                <input
                  value={row.type}
                  disabled={!canEdit}
                  placeholder="Professional liability"
                  onChange={(event) => setRow(index, { type: event.target.value })}
                  className={fieldInput}
                />
              </label>
              <label className={fieldLabel}>
                <span>{t("sections.insurancePolicies.amount")}</span>
                <input
                  value={row.amount}
                  disabled={!canEdit}
                  placeholder="€2,000,000"
                  onChange={(event) => setRow(index, { amount: event.target.value })}
                  className={fieldInput}
                />
              </label>
              {canEdit && (
                <div className="flex items-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-[#c02626] hover:bg-[#fdeaea]"
                    onClick={() => {
                      setRows((prev) => prev.filter((_, i) => i !== index));
                      setStatus("idle");
                    }}
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
              )}
              <label className={`${fieldLabel} sm:col-span-3`}>
                <span>{t("sections.insurancePolicies.details")}</span>
                <input
                  value={row.details ?? ""}
                  disabled={!canEdit}
                  onChange={(event) => setRow(index, { details: event.target.value })}
                  className={fieldInput}
                />
              </label>
            </div>
          ))}
        </div>
      )}
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
