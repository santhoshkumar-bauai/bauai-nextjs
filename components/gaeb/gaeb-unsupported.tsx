"use client";

import { Download, FileWarning } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

/** Clean terminal states: parse failure, legacy flavor, view-only phase. */
export function GaebUnsupported({
  variant,
  code,
  extension,
  phase,
  onDownload,
}: {
  variant: "parse_error" | "legacy" | "phase";
  code?: string;
  extension?: string;
  phase?: number;
  onDownload: () => void;
}) {
  const t = useTranslations("Gaeb.unsupported");
  const title =
    variant === "legacy"
      ? t("legacyTitle")
      : variant === "phase"
        ? t("phaseTitle")
        : t("parseFailedTitle");
  const body =
    variant === "legacy"
      ? t("legacyBody", { extension: `.${extension ?? ""}` })
      : variant === "phase"
        ? t("phaseBody", { phase: phase ?? 0 })
        : t("parseFailedBody", { code: code ?? "unknown" });

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 text-center">
        <FileWarning className="mx-auto size-8 text-amber-500" />
        <h2 className="mt-3 text-base font-semibold text-foreground">{title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{body}</p>
        <Button variant="outline" className="mt-5" onClick={onDownload}>
          <Download />
          {t("download")}
        </Button>
      </div>
    </div>
  );
}
