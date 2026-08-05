import { redirect } from "next/navigation";

import { InsurancesEditor } from "@/components/settings/insurances-editor";
import { SectionForm } from "@/components/settings/section-form";
import { getSettingsData } from "@/lib/company/settings-data";
import { INSURANCE_DETAILS_SECTION } from "@/lib/company/settings-sections";

export default async function InsurancePage() {
  const data = await getSettingsData();
  if (!data) redirect("/dashboard");
  return (
    <>
      <SectionForm
        profile={data.profile}
        config={INSURANCE_DETAILS_SECTION}
        canEdit={data.canEdit}
      />
      <InsurancesEditor profile={data.profile} canEdit={data.canEdit} />
    </>
  );
}
