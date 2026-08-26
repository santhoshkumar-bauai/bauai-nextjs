import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { IrisWorkspace } from "@/components/gen-ui/iris-workspace";
import { aiRoleConfigured } from "@/lib/ai/gateway/config";
import { getCompanyContext } from "@/lib/company/context";

export const metadata: Metadata = {
  title: "Iris — generative interface",
};

/**
 * Iris: the generative-UI agent POC.
 *
 * The same auth gate as the chat route, evaluated here too, so an unconfigured
 * deployment explains itself in the composer instead of failing on the user's
 * first message.
 */
export default async function GenUiPocPage() {
  const context = await getCompanyContext();
  if (!context) redirect("/login");

  return (
    <IrisWorkspace
      companyName={context.company.name}
      aiAvailable={aiRoleConfigured("iris")}
    />
  );
}
