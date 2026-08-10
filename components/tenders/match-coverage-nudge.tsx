"use client";

import { FileUp, Lightbulb } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

export interface MatchCoverage {
  facets: number;
  profileFacets: number;
  documentFacets: number;
  skipped: ReadonlyArray<{ key: string; reason: "too_short" | "absent" }>;
}

/**
 * Tells the user, concretely, what is holding their matching back.
 *
 * Matching degrades gracefully when a company has thin data — but silently, so
 * a company with one facet gets mediocre results and no idea why. This turns
 * the coverage numbers the pipeline already records into the specific next
 * action: upload documents, or fill in the profile.
 */
export function MatchCoverageNudge({ coverage }: { coverage: MatchCoverage }) {
  const t = useTranslations("Tenders.aiMatched.coverage");

  const needsDocuments = coverage.documentFacets === 0;
  const needsProfile = coverage.profileFacets <= 1;

  // Nothing worth nagging about — the profile is doing its job.
  if (!needsDocuments && !needsProfile) return null;

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2.5">
        <Lightbulb className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-medium text-foreground">{t("title")}</span>
          <span className="text-xs text-muted-foreground">
            {t("signals", {
              profileFacets: coverage.profileFacets,
              documentFacets: coverage.documentFacets,
            })}{" "}
            {needsDocuments ? t("addDocuments") : t("addProfile")}
          </span>
        </div>
      </div>
      <Link
        href={needsDocuments ? "/settings/documents" : "/settings/tender-information"}
        className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
      >
        <FileUp className="size-3.5" />
        {needsDocuments ? t("documentsLink") : t("profileLink")}
      </Link>
    </div>
  );
}
