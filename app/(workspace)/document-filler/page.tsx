import { redirect } from "next/navigation";

import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { DocumentFillerWorkspace } from "@/components/onlyoffice/document-filler-workspace";
import { buildDashboardCopy } from "@/lib/dashboard/shell-copy";
import { getCompanyContext } from "@/lib/company/context";
import { serializeWorkspaceDocument } from "@/lib/onlyoffice/serialize";
import { WorkspaceDocument } from "@/models/workspace-document";

export default async function DocumentFillerPage() {
  const context = await getCompanyContext();
  if (!context) redirect("/login");
  const [copy, documents] = await Promise.all([
    buildDashboardCopy(),
    WorkspaceDocument.find({
      companyId: context.company._id,
      deletedAt: null,
    }).sort({ updatedAt: -1 }),
  ]);
  return (
    <DashboardShell
      firstName={context.name.split(/\s+/)[0]}
      fullName={context.name}
      email={context.email}
      dateLabel=""
      copy={copy}
      workspaceContent={
        <DocumentFillerWorkspace
          initialDocuments={documents.map(serializeWorkspaceDocument)}
          canDelete={context.role === "admin"}
        />
      }
    />
  );
}
