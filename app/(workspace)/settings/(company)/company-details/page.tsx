import { redirect } from "next/navigation";

import { SectionForm } from "@/components/settings/section-form";
import { getSettingsData } from "@/lib/company/settings-data";
import { COMPANY_DETAILS_SECTION } from "@/lib/company/settings-sections";

export default async function CompanyDetailsPage() {
  const data = await getSettingsData();
  if (!data) redirect("/dashboard");
  return (
    <SectionForm
      profile={data.profile}
      config={COMPANY_DETAILS_SECTION}
      canEdit={data.canEdit}
    />
  );
}
