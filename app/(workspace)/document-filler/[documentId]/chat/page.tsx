import { notFound, redirect } from "next/navigation";

import { FillChatWorkspace } from "@/components/fill-agent/fill-chat-workspace";
import { ensureDocumentFillSession } from "@/lib/ai/fill-agent/document-session";
import { getCompanyContext } from "@/lib/company/context";
import { aiProviderConfigured } from "@/lib/ai/gateway/config";

/**
 * "Open in chat" for a PDF in the document filler: lazily binds a fill
 * session to the document's current version and renders the fill workspace.
 * Documents the agent cannot fill (scanned, no version yet) bounce back to
 * the chooser, which explains via the editor path.
 */
export default async function DocumentFillChatPage({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const context = await getCompanyContext();
  if (!context) redirect("/login");
  const { documentId } = await params;

  const result = await ensureDocumentFillSession({
    companyContext: context,
    documentIdHex: documentId,
  });
  if ("error" in result) {
    if (result.error === "not_found") notFound();
    // Not chat-fillable — the editor still works; send them there.
    redirect(`/document-filler/${documentId}?mode=editor`);
  }

  const aiAvailable = Boolean(
    aiProviderConfigured(),
  );
  return (
    <FillChatWorkspace
      sessionId={String(result.session._id)}
      aiAvailable={aiAvailable}
      backHref={`/document-filler/${documentId}`}
      backLabelKey="chooserBack"
    />
  );
}
