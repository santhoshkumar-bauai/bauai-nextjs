"use client";

import { ChevronDown, FileSearch, Loader2, Quote, ScanSearch } from "lucide-react";
import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { EXTRACTION_SCHEMA_NAMES } from "@/lib/ai/extraction/schema-names";
import { cn } from "@/lib/utils";
import { ExtractionValue } from "./extraction-value";
import { SectionLabel } from "./field";
import {
  useExtractions,
  type ExtractionRecordView,
  type SchemaRunState,
  type StoredCitedValueView,
} from "./use-extractions";

const RECORD_STATUS_VARIANT = {
  VERIFIED: "success",
  PARTIAL: "warning",
  EMPTY: "neutral",
  FAILED: "danger",
} as const;

const CITATION_VARIANT = {
  VERIFIED: "success",
  UNVERIFIED: "warning",
  MISSING: "neutral",
} as const;

function FieldRow({
  fieldName,
  field,
  schemaName,
}: {
  fieldName: string;
  field: StoredCitedValueView;
  schemaName: string;
}) {
  const t = useTranslations("Tenders.ai");
  const [showCitations, setShowCitations] = useState(false);

  if (field.value == null) return null;
  const citations = field.citations.filter((citation) => citation.quote);

  return (
    <div className="flex flex-col gap-1 border-b border-border/60 py-2 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {t(`fields.${schemaName}.${fieldName}` as "fields.deadlines.submissionDeadline")}
        </span>
        <Badge variant={CITATION_VARIANT[field.citationState]}>
          {t(`citation.${field.citationState}` as "citation.VERIFIED")}
        </Badge>
      </div>
      <div className="text-xs font-medium text-foreground">
        <ExtractionValue fieldName={fieldName} value={field.value} />
      </div>
      {citations.length > 0 && (
        <button
          type="button"
          onClick={() => setShowCitations(!showCitations)}
          className="flex w-fit items-center gap-1 text-[10px] text-muted-foreground hover:text-primary"
        >
          <Quote className="size-2.5" />
          {t("citation.showQuote", { count: citations.length })}
          <ChevronDown
            className={cn("size-2.5 transition-transform", showCitations && "rotate-180")}
          />
        </button>
      )}
      {showCitations &&
        citations.map((citation, index) => (
          <blockquote
            key={index}
            className="border-l-2 border-primary/30 pl-2 text-[11px] italic text-muted-foreground"
          >
            {`„${citation.quote}“`}
          </blockquote>
        ))}
    </div>
  );
}

function SchemaCard({
  schemaName,
  record,
  runState,
}: {
  schemaName: string;
  record: ExtractionRecordView | undefined;
  runState: SchemaRunState | undefined;
}) {
  const t = useTranslations("Tenders.ai");
  const format = useFormatter();

  const isRunning = runState === "RUNNING" || runState === "PENDING";
  const nonNullFields = record
    ? Object.entries(record.fields).filter(([, field]) => field.value != null)
    : [];

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="text-xs font-semibold text-foreground">
          {t(`schemas.${schemaName}` as "schemas.deadlines")}
        </span>
        {isRunning ? (
          <Badge variant="info">
            <Loader2 className="animate-spin" />
            {t("running")}
          </Badge>
        ) : runState === "FAILED" && !record ? (
          <Badge variant="danger">{t("status.FAILED")}</Badge>
        ) : record ? (
          <Badge variant={RECORD_STATUS_VARIANT[record.status]}>
            {t(`status.${record.status}` as "status.VERIFIED")}
          </Badge>
        ) : (
          <Badge variant="neutral">{t("status.NOT_STARTED")}</Badge>
        )}
      </div>

      {record && nonNullFields.length > 0 && (
        <div className="flex flex-col border-t border-border px-3">
          {nonNullFields.map(([fieldName, field]) => (
            <FieldRow
              key={fieldName}
              fieldName={fieldName}
              field={field}
              schemaName={schemaName}
            />
          ))}
        </div>
      )}

      {record && (
        <div className="flex items-center justify-between border-t border-border/60 px-3 py-1.5 text-[10px] text-muted-foreground">
          <span>
            {t("statsFooter", {
              verified: record.stats.verifiedFields,
              total: record.stats.totalFields,
            })}
          </span>
          <span>
            {format.dateTime(new Date(record.extractedAt), {
              dateStyle: "short",
              timeStyle: "short",
            })}
          </span>
        </div>
      )}
    </div>
  );
}

/** "AI Information": citation-verified extraction results for the tender. */
export function ExtractionsSection({ tenderId }: { tenderId: string | null }) {
  const t = useTranslations("Tenders.ai");
  const { records, runStates, corpusReady, analyzing, error, analyze } =
    useExtractions(tenderId);

  const recordsByName = new Map(records.map((record) => [record.schemaName, record]));
  const doneCount = EXTRACTION_SCHEMA_NAMES.filter((name) => {
    const state = runStates[name];
    return state === "DONE" || state === "FAILED" || recordsByName.has(name);
  }).length;
  const hasAny = records.length > 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>
          <span className="inline-flex items-center gap-1.5">
            <FileSearch className="size-3.5" />
            {t("title")}
          </span>
        </SectionLabel>
        {corpusReady !== false && (
          <button
            type="button"
            onClick={analyze}
            disabled={analyzing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {analyzing ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <ScanSearch className="size-3" />
            )}
            {analyzing ? t("analyzing") : hasAny ? t("reanalyze") : t("analyze")}
          </button>
        )}
      </div>

      {corpusReady === false && (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {t("noCorpus")}
        </p>
      )}

      {analyzing && (
        <div className="flex items-center gap-2">
          <Progress value={doneCount / EXTRACTION_SCHEMA_NAMES.length} className="flex-1" />
          <span className="text-[10px] text-muted-foreground">
            {doneCount}/{EXTRACTION_SCHEMA_NAMES.length}
          </span>
        </div>
      )}

      {error === "timeout" && (
        <p className="text-center text-[11px] text-muted-foreground">{t("timeout")}</p>
      )}
      {error === "request" && (
        <p className="text-center text-[11px] text-muted-foreground">{t("error")}</p>
      )}

      {(hasAny || analyzing) &&
        EXTRACTION_SCHEMA_NAMES.map((schemaName) => (
          <SchemaCard
            key={schemaName}
            schemaName={schemaName}
            record={recordsByName.get(schemaName)}
            runState={runStates[schemaName]}
          />
        ))}

      {!hasAny && !analyzing && corpusReady !== false && (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {t("intro")}
        </p>
      )}
    </div>
  );
}
