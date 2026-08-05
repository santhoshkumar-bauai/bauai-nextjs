import { redirect } from "next/navigation";

import { SectionForm } from "@/components/settings/section-form";
import { getSettingsData } from "@/lib/company/settings-data";
import { PRINCIPAL_OFFICE_SECTION } from "@/lib/company/settings-sections";

export default async function PrincipalOfficePage() {
  const data = await getSettingsData();
  if (!data) redirect("/dashboard");
  return (
    <SectionForm
      profile={data.profile}
      config={PRINCIPAL_OFFICE_SECTION}
      canEdit={data.canEdit}
    />
  );
}
