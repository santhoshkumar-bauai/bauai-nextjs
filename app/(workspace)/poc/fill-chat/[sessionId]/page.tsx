import { ObjectId } from "mongodb";
import { notFound, redirect } from "next/navigation";

import { FillChatWorkspace } from "@/components/fill-agent/fill-chat-workspace";
import { getFillSession } from "@/lib/ai/fill-agent/store";
import { forCompanyContext } from "@/lib/ai/tenant/repository";
import { getCompanyContext } from "@/lib/company/context";
import { aiProviderConfigured } from "@/lib/ai/gateway/config";

/** One fill session: chat + preview workspace. */
export default async function FillChatSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const context = await getCompanyContext();
  if (!context) redirect("/login");
  const { sessionId } = await params;
  if (!ObjectId.isValid(sessionId)) notFound();
  const session = await getFillSession(
    forCompanyContext(context).value,
    new ObjectId(sessionId),
  );
  if (!session) notFound();
  // Same provider gate the chat route enforces, computed server-side so the
  // panel can explain itself instead of failing on first send.
  const aiAvailable = Boolean(
    aiProviderConfigured(),
  );
  return <FillChatWorkspace sessionId={sessionId} aiAvailable={aiAvailable} />;
}
