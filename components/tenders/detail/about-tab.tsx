"use client";

import { useLocale, useTranslations } from "next-intl";

import type { SerializedTenderDetail } from "@/lib/tenders/detail";
import { ClientCard } from "./client-card";
import { Field, SectionLabel } from "./field";
import { formatValue } from "./format";

/** CPV chip with the sector label resolved from the division prefix. */
function CpvChip({ code }: { code: string }) {
  const t = useTranslations("Tenders");
  const division = code.slice(0, 2);
  let label: string | null = null;
  // Sector keys exist only for known divisions; t.has avoids throwing.
  if (t.has(`sector.${division}` as "sector.45")) {
    label = t(`sector.${division}` as "sector.45");
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
      <span className="font-mono">{code}</span>
      {label && <span className="text-muted-foreground/70">· {label}</span>}
    </span>
  );
}

export function AboutTab({ detail }: { detail: SerializedTenderDetail }) {
  const t = useTranslations("Tenders");
  const locale = useLocale();

  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
        <Field label={t("detail.status")}>
          {t(`status.${detail.status}` as "status.OPEN", {}) as string}
        </Field>
        <Field label={t("detail.value")}>
          {formatValue(
            detail.estimatedValue?.amount ?? null,
            detail.estimatedValue?.currency ?? null,
            locale,
          ) ?? t("card.notProvided")}
        </Field>
        <Field label={t("detail.procedure")}>{detail.procedureType ?? "—"}</Field>
        <Field label={t("detail.contractNature")}>
          {detail.contractNature ?? "—"}
        </Field>
        {detail.language && (
          <Field label={t("detail.language")}>
            {detail.language.toUpperCase()}
          </Field>
        )}
        {detail.countries.length > 0 && (
          <Field label={t("detail.countries")}>
            {detail.countries.join(", ")}
          </Field>
        )}
      </dl>

      {detail.regions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <SectionLabel>{t("detail.regions")}</SectionLabel>
          <div className="flex flex-wrap gap-1">
            {detail.regions.map((region) => (
              <span
                key={region}
                className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              >
                {region}
              </span>
            ))}
          </div>
        </div>
      )}

      {detail.cpvCodes.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <SectionLabel>{t("detail.cpv")}</SectionLabel>
          <div className="flex flex-wrap gap-1">
            {detail.cpvCodes.map((code) => (
              <CpvChip key={code} code={code} />
            ))}
          </div>
        </div>
      )}

      {detail.description && (
        <div className="flex flex-col gap-1.5">
          <SectionLabel>{t("detail.description")}</SectionLabel>
          <p className="text-sm whitespace-pre-wrap text-foreground/90">
            {detail.description}
          </p>
        </div>
      )}

      {detail.buyer && <ClientCard buyer={detail.buyer} />}
    </div>
  );
}
