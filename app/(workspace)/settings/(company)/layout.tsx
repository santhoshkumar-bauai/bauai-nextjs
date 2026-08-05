import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { CompanySidebar } from "@/components/settings/company-sidebar";
import { computeProfileCompletion } from "@/lib/company/completion";
import { getSettingsData } from "@/lib/company/settings-data";

/**
 * Wraps the Company Information sub-sections with the shared KB sidebar. Each
 * child page is its own route (/settings/company-info, /settings/insurance, …).
 */
export default async function CompanySettingsLayout({
  children,
}: {
  children: ReactNode;
}) {
  const data = await getSettingsData();
  if (!data) redirect("/dashboard");

  return (
    <div className="mx-auto mt-7 grid max-w-[1320px] grid-cols-1 gap-7 lg:grid-cols-[234px_minmax(0,1fr)]">
      <CompanySidebar completion={computeProfileCompletion(data.profile)} />
      <div className="min-w-0 grid gap-[18px]">{children}</div>
    </div>
  );
}
