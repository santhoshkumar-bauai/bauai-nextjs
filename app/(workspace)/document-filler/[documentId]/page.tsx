import { isValidObjectId } from "mongoose";
import { notFound, redirect } from "next/navigation";

import { EditorWorkspace } from "@/components/onlyoffice/editor-workspace";
import { getCompanyContext } from "@/lib/company/context";
import { WorkspaceDocument } from "@/models/workspace-document";

export default async function DocumentEditorPage({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const context = await getCompanyContext();
  if (!context) redirect("/login");
  const { documentId } = await params;
  if (!isValidObjectId(documentId)) notFound();
  const document = await WorkspaceDocument.findOne({
    _id: documentId,
    companyId: context.company._id,
    deletedAt: null,
  }).lean();
  if (!document) notFound();
  return <EditorWorkspace documentId={documentId} fileName={document.fileName} />;
}
