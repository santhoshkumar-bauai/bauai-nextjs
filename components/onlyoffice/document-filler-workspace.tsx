"use client";

import { Briefcase, FolderOpen } from "lucide-react";
import { useTranslations } from "next-intl";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SerializedWorkspaceDocument } from "@/lib/onlyoffice/serialize";

import { DocumentLibrary } from "./document-library";
import { TenderWorkspaceBrowser } from "./tender-workspace-browser";

/**
 * The Document Filler page shell: the company's own documents on one side, the
 * tenders already on the kanban board on the other. Both roads lead to the same
 * editor — the tender tab just creates the working copy first.
 */
export function DocumentFillerWorkspace({
  initialDocuments,
  canDelete,
}: {
  initialDocuments: SerializedWorkspaceDocument[];
  canDelete: boolean;
}) {
  const t = useTranslations("DocumentFiller");

  return (
    <div className="h-full overflow-y-auto p-5 sm:p-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header>
          <p className="text-xs font-bold tracking-[.14em] text-primary uppercase">
            {t("library.eyebrow")}
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-foreground">
            {t("library.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("library.subtitle")}</p>
        </header>

        <Tabs defaultValue="documents" className="gap-5">
          <TabsList className="w-full max-w-md">
            <TabsTrigger value="documents">
              <FolderOpen />
              {t("tabs.documents")}
            </TabsTrigger>
            <TabsTrigger value="tenders">
              <Briefcase />
              {t("tabs.tenders")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="documents">
            <DocumentLibrary initialDocuments={initialDocuments} canDelete={canDelete} />
          </TabsContent>
          <TabsContent value="tenders">
            <TenderWorkspaceBrowser />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
