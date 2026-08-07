"use client";

import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  ExternalLink,
  FileText,
  Globe,
  Lightbulb,
  Loader2,
  Mail,
  Phone,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SerializedTenderDetail } from "@/lib/tenders/detail";
import type {
  FitVerdict,
  TenderRecommendation,
} from "@/lib/tenders/recommendation";
import { cn } from "@/lib/utils";

const VERDICT_STYLES: Record<FitVerdict, string> = {
  STRONG_FIT: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  POSSIBLE_FIT: "bg-sky-50 text-sky-700 ring-sky-600/20",
  WEAK_FIT: "bg-amber-50 text-amber-700 ring-amber-600/20",
  NOT_RECOMMENDED: "bg-rose-50 text-rose-700 ring-rose-600/20",
};

function formatValue(amount: string | null, currency: string | null): string | null {
  if (!amount) return null;
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return null;
  try {
    return new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency: currency || "EUR",
      maximumFractionDigits: 0,
    }).format(numeric);
  } catch {
    return `${numeric.toLocaleString("de-DE")} ${currency ?? ""}`.trim();
  }
}

export function TenderDetailDialog({
  tenderId,
  onClose,
}: {
  tenderId: string | null;
  onClose: () => void;
}) {
  const t = useTranslations("Tenders");
  const format = useFormatter();
  const locale = useLocale();

  const [detail, setDetail] = useState<SerializedTenderDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const [rec, setRec] = useState<TenderRecommendation | null>(null);
  const [recLoading, setRecLoading] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);

  useEffect(() => {
    if (!tenderId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setDetail(null);
      setError(false);
      setLoading(true);
      setRec(null);
      setRecError(null);
      fetch(`/api/tenders/${tenderId}`, { signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json() as Promise<{ tender: SerializedTenderDetail }>;
        })
        .then((json) => setDetail(json.tender))
        .catch(() => {
          if (!controller.signal.aborted) setError(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [tenderId]);

  const generateRecommendation = useCallback(async () => {
    if (!tenderId) return;
    setRecLoading(true);
    setRecError(null);
    try {
      const response = await fetch(
        `/api/tenders/${tenderId}/recommendation?locale=${locale}`,
        { method: "POST" },
      );
      const json = (await response.json()) as {
        recommendation?: TenderRecommendation;
        error?: string;
      };
      if (!response.ok || !json.recommendation) {
        setRecError(json.error || t("recommendation.error"));
        return;
      }
      setRec(json.recommendation);
    } catch {
      setRecError(t("recommendation.error"));
    } finally {
      setRecLoading(false);
    }
  }, [tenderId, locale, t]);

  const buyerLocation = detail?.buyer?.address
    ? [detail.buyer.address.city, detail.buyer.address.postalCode]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <Dialog open={tenderId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="h-[85svh] max-h-[680px] max-w-2xl">
        <DialogHeader>
          <DialogTitle className="pr-2">
            {loading ? t("detail.loading") : (detail?.title ?? "—")}
          </DialogTitle>
          <DialogDescription>
            {[detail?.buyer?.name, buyerLocation].filter(Boolean).join(" — ") || " "}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="grid min-h-0 flex-1 place-items-center text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : error || !detail ? (
          <div className="grid min-h-0 flex-1 place-items-center text-sm text-muted-foreground">
            {t("states.errorTitle")}
          </div>
        ) : (
          <Tabs defaultValue="about" className="flex min-h-0 flex-1 flex-col gap-0">
            <div className="border-b border-border px-6 py-3">
              <TabsList className="w-full">
                <TabsTrigger value="about">{t("detail.tabs.about")}</TabsTrigger>
                <TabsTrigger value="documents">
                  {t("detail.tabs.documents")}
                </TabsTrigger>
                <TabsTrigger value="schedule">
                  {t("detail.tabs.schedule")}
                </TabsTrigger>
                <TabsTrigger value="ai">
                  <Sparkles className="size-3.5" />
                  {t("detail.tabs.ai")}
                </TabsTrigger>
              </TabsList>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
              {/* ABOUT */}
              <TabsContent value="about" className="flex flex-col gap-4 pt-2">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                  <Field label={t("detail.status")}>
                    {t(`status.${detail.status}` as "status.OPEN", {}) as string}
                  </Field>
                  <Field label={t("detail.value")}>
                    {formatValue(
                      detail.estimatedValue?.amount ?? null,
                      detail.estimatedValue?.currency ?? null,
                    ) ?? t("card.notProvided")}
                  </Field>
                  <Field label={t("detail.procedure")}>
                    {detail.procedureType ?? "—"}
                  </Field>
                  <Field label={t("detail.contractNature")}>
                    {detail.contractNature ?? "—"}
                  </Field>
                </dl>

                {detail.cpvCodes.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("detail.cpv")}
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {detail.cpvCodes.map((code) => (
                        <span
                          key={code}
                          className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                        >
                          {code}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {detail.description && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("detail.description")}
                    </span>
                    <p className="text-sm whitespace-pre-wrap text-foreground/90">
                      {detail.description}
                    </p>
                  </div>
                )}

                {detail.buyer && (
                  <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                      <Building2 className="size-3.5" />
                      {detail.buyer.name ?? t("detail.buyer")}
                    </span>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {detail.buyer.email && (
                        <a
                          href={`mailto:${detail.buyer.email}`}
                          className="inline-flex items-center gap-1 hover:text-primary"
                        >
                          <Mail className="size-3" />
                          {detail.buyer.email}
                        </a>
                      )}
                      {detail.buyer.phone && (
                        <span className="inline-flex items-center gap-1">
                          <Phone className="size-3" />
                          {detail.buyer.phone}
                        </span>
                      )}
                      {detail.buyer.website && (
                        <a
                          href={detail.buyer.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 hover:text-primary"
                        >
                          <Globe className="size-3" />
                          {t("detail.website")}
                        </a>
                      )}
                    </div>
                  </div>
                )}
              </TabsContent>

              {/* DOCUMENTS */}
              <TabsContent value="documents" className="flex flex-col gap-2 pt-2">
                {detail.documents.length === 0 && detail.sourceLinks.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    {t("detail.noDocuments")}
                  </p>
                ) : (
                  <>
                    {detail.documents.map((doc, index) => (
                      <a
                        key={`${doc.url}-${index}`}
                        href={doc.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group flex items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:border-primary/40 hover:bg-muted/50"
                      >
                        <FileText className="size-4 shrink-0 text-muted-foreground" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm text-foreground">
                            {doc.kind ?? t("detail.document")}
                          </span>
                          <span className="truncate text-[11px] text-muted-foreground">
                            {doc.url}
                          </span>
                        </span>
                        {doc.restricted && (
                          <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700 ring-1 ring-amber-600/20">
                            {t("detail.restricted")}
                          </span>
                        )}
                        <ExternalLink className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                      </a>
                    ))}
                    {detail.sourceLinks
                      .filter((link) => link.url)
                      .map((link, index) => (
                        <a
                          key={`${link.url}-${index}`}
                          href={link.url as string}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="group flex items-center gap-3 rounded-lg border border-dashed border-border p-3 transition-colors hover:border-primary/40 hover:bg-muted/50"
                        >
                          <Globe className="size-4 shrink-0 text-muted-foreground" />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="text-sm text-foreground">
                              {t("detail.sourcePortal")} · {link.source}
                            </span>
                            <span className="truncate text-[11px] text-muted-foreground">
                              {link.url}
                            </span>
                          </span>
                          <ExternalLink className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                        </a>
                      ))}
                  </>
                )}
              </TabsContent>

              {/* SCHEDULE */}
              <TabsContent value="schedule" className="flex flex-col gap-3 pt-2">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                  <Field label={t("detail.publication")}>
                    {detail.publicationDate
                      ? format.dateTime(new Date(detail.publicationDate), {
                          dateStyle: "medium",
                        })
                      : "—"}
                  </Field>
                  <Field label={t("card.deadline")}>
                    {detail.submissionDeadline
                      ? format.dateTime(new Date(detail.submissionDeadline), {
                          dateStyle: "medium",
                        })
                      : t("card.noDeadline")}
                  </Field>
                </dl>

                {detail.lots.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("detail.lots")} ({detail.lots.length})
                    </span>
                    <div className="flex flex-col gap-1.5">
                      {detail.lots.map((lot) => (
                        <div
                          key={lot.lotId}
                          className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-xs"
                        >
                          <span className="min-w-0 truncate text-foreground">
                            {lot.title ?? lot.lotId}
                          </span>
                          <span className="shrink-0 text-muted-foreground">
                            {lot.submissionDeadline
                              ? format.dateTime(new Date(lot.submissionDeadline), {
                                  dateStyle: "medium",
                                })
                              : t("card.noDeadline")}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </TabsContent>

              {/* AI RECOMMENDATION */}
              <TabsContent value="ai" className="flex flex-col gap-3 pt-2">
                {!rec && !recLoading && (
                  <div className="flex flex-col items-center gap-3 py-8 text-center">
                    <Sparkles className="size-6 text-primary" />
                    <p className="max-w-sm text-xs text-muted-foreground">
                      {t("recommendation.intro")}
                    </p>
                    <button
                      type="button"
                      onClick={generateRecommendation}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                    >
                      <Sparkles className="size-3.5" />
                      {t("recommendation.generate")}
                    </button>
                  </div>
                )}

                {recLoading && (
                  <div className="flex flex-col items-center gap-2 py-10 text-sm text-muted-foreground">
                    <Loader2 className="size-5 animate-spin" />
                    {t("recommendation.analyzing")}
                  </div>
                )}

                {recError && !recLoading && (
                  <div className="flex flex-col items-center gap-2 py-8 text-center text-sm">
                    <p className="text-muted-foreground">{recError}</p>
                    <button
                      type="button"
                      onClick={generateRecommendation}
                      className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                    >
                      {t("recommendation.retry")}
                    </button>
                  </div>
                )}

                {rec && !recLoading && (
                  <div className="flex flex-col gap-4">
                    <div className="flex items-center justify-between gap-3">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset",
                          VERDICT_STYLES[rec.verdict],
                        )}
                      >
                        {t(`recommendation.verdict.${rec.verdict}` as "recommendation.verdict.STRONG_FIT")}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {t("recommendation.fitScore")}
                        </span>
                        <span className="text-sm font-semibold text-foreground">
                          {rec.fitScore}
                        </span>
                      </div>
                    </div>

                    {rec.summary && (
                      <p className="text-sm text-foreground/90">{rec.summary}</p>
                    )}

                    {rec.strengths.length > 0 && (
                      <RecList
                        title={t("recommendation.strengths")}
                        items={rec.strengths}
                        icon={
                          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                        }
                      />
                    )}
                    {rec.concerns.length > 0 && (
                      <RecList
                        title={t("recommendation.concerns")}
                        items={rec.concerns}
                        icon={
                          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                        }
                      />
                    )}
                    {rec.suggestedActions.length > 0 && (
                      <RecList
                        title={t("recommendation.actions")}
                        items={rec.suggestedActions}
                        icon={
                          <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-sky-600" />
                        }
                      />
                    )}

                    <p className="text-[10px] text-muted-foreground">
                      {t("recommendation.disclaimer")}
                    </p>
                  </div>
                )}
              </TabsContent>
            </div>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{children}</dd>
    </div>
  );
}

function RecList({
  title,
  items,
  icon,
}: {
  title: string;
  items: string[];
  icon: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{title}</span>
      <ul className="flex flex-col gap-1">
        {items.map((item, index) => (
          <li key={index} className="flex items-start gap-1.5 text-xs text-foreground/90">
            {icon}
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
