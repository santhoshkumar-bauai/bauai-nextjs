import { redirect } from "next/navigation";

import { FillChatHome } from "@/components/fill-agent/fill-chat-home";
import { fillAgentEnv } from "@/lib/ai/fill-agent/env";
import { getCompanyContext } from "@/lib/company/context";

/** Fill-agent POC landing page: upload a PDF form, pick a session. */
export default async function FillChatHomePage() {
  const context = await getCompanyContext();
  if (!context) redirect("/login");
  return <FillChatHome maxPages={fillAgentEnv().maxPages} />;
}
