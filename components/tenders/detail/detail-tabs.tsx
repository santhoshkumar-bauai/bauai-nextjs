"use client";

import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SerializedTenderDetail } from "@/lib/tenders/detail";
import type { SerializedTenderFile } from "@/lib/tenders/document-files";
import { AboutTab } from "./about-tab";
import { DocumentsTab } from "./documents-tab";
import type { DocumentFetchState } from "./use-tender-detail";
import { ExtractionsSection } from "./extractions-section";
import { ScheduleTab } from "./schedule-tab";

/**
 * About / Documents / Schedule / AI for one tender. The popup and the full-page
 * view render the very same tabs — only the surrounding chrome differs, which
 * is what the class-name props are for.
 */
export function TenderDetailTabs({
  tenderId,
  detail,
  files,
  docFetch,
  className,
  listWrapperClassName,
  panelClassName,
  initialTab = "about",
}: {
  tenderId: string | null;
  detail: SerializedTenderDetail;
  files: SerializedTenderFile[];
  docFetch?: DocumentFetchState;
  className?: string;
  listWrapperClassName?: string;
  panelClassName?: string;
  /** Which tab opens first — e.g. "documents" when launched from the kanban board. */
  initialTab?: "about" | "documents" | "schedule" | "ai";
}) {
  const t = useTranslations("Tenders");

  return (
    <Tabs defaultValue={initialTab} className={className}>
      <div className={listWrapperClassName}>
        <TabsList className="w-full">
          <TabsTrigger value="about">{t("detail.tabs.about")}</TabsTrigger>
          <TabsTrigger value="documents">{t("detail.tabs.documents")}</TabsTrigger>
          <TabsTrigger value="schedule">{t("detail.tabs.schedule")}</TabsTrigger>
          <TabsTrigger value="ai">
            <Sparkles className="size-3.5" />
            {t("detail.tabs.ai")}
          </TabsTrigger>
        </TabsList>
      </div>
      <div className={panelClassName}>
        <TabsContent value="about" className="pt-2">
          <AboutTab detail={detail} />
        </TabsContent>
        <TabsContent value="documents" className="pt-2">
          <DocumentsTab detail={detail} files={files} docFetch={docFetch} />
        </TabsContent>
        <TabsContent value="schedule" className="pt-2">
          <ScheduleTab detail={detail} />
        </TabsContent>
        <TabsContent value="ai" className="pt-2 pb-16">
          <ExtractionsSection tenderId={tenderId} />
        </TabsContent>
      </div>
    </Tabs>
  );
}
