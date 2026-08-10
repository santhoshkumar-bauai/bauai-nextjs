"use client";

import { AlertTriangle, FileText, Sparkles, Wrench } from "lucide-react";
import { useTranslations } from "next-intl";

import type { AiMatchAnnotation } from "@/lib/tenders/serialize";

/**
 * Why this tender is in the AI feed.
 *
 * Facet keys are opaque ids (`reference:2`, `doc:company:66f…`), so they are
 * mapped to a human label here: the facet's own label when it has one (a
 * reference-project title, a filename), otherwise the kind of signal it is.
 */
function facetLabel(
  facet: AiMatchAnnotation["matchedOn"][number],
  t: (key: string) => string,
): string {
  if (facet.label) return facet.label;
  if (facet.key.startsWith("reference:")) return t("sources.reference");
  if (facet.key.startsWith("doc:")) return t("sources.document");
  if (facet.key === "qualifications") return t("sources.qualifications");
  return t("sources.capabilities");
}

export function AiMatchReason({ match }: { match: AiMatchAnnotation }) {
  const t = useTranslations("Tenders.aiMatched.card");

  const hasReason = Boolean(match.reason);
  const hasStrengths = match.matchedCapabilities.length > 0;
  const hasConcerns = match.concerns.length > 0;
  const hasFacets = match.matchedOn.length > 0;

  if (!hasReason && !hasStrengths && !hasConcerns && !hasFacets) return null;

  return (
    <div className="flex flex-col gap-2">
      {hasReason && (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-foreground/80">
          <Sparkles className="mt-0.5 size-3 shrink-0 text-primary" />
          <span>{match.reason}</span>
        </p>
      )}

      {hasStrengths && (
        <div className="flex flex-wrap items-center gap-1">
          {match.matchedCapabilities.map((capability) => (
            <span
              key={capability}
              className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-600/20 ring-inset"
            >
              <Wrench className="size-2.5" />
              {capability}
            </span>
          ))}
        </div>
      )}

      {hasConcerns && (
        <div className="flex flex-wrap items-center gap-1">
          {match.concerns.map((concern) => (
            <span
              key={concern}
              className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-600/20 ring-inset"
            >
              <AlertTriangle className="size-2.5" />
              {concern}
            </span>
          ))}
        </div>
      )}

      {hasFacets && (
        <p className="flex items-start gap-1.5 text-[10px] text-muted-foreground">
          <FileText className="mt-0.5 size-2.5 shrink-0" />
          <span>
            {t("matchedVia")}:{" "}
            {match.matchedOn.map((facet) => facetLabel(facet, t)).join(" · ")}
          </span>
        </p>
      )}
    </div>
  );
}
