import { redirect } from "next/navigation";

import { SectionForm } from "@/components/settings/section-form";
import { getSettingsData } from "@/lib/company/settings-data";
import {
  BANK_DETAILS_SECTION,
  FINANCIAL_INFO_SECTION,
} from "@/lib/company/settings-sections";

export default async function FinancialInformationPage() {
  const data = await getSettingsData();
  if (!data) redirect("/dashboard");
  return (
    <>
      <SectionForm
        profile={data.profile}
        config={FINANCIAL_INFO_SECTION}
        canEdit={data.canEdit}
      />
      <SectionForm
        profile={data.profile}
        config={BANK_DETAILS_SECTION}
        canEdit={data.canEdit}
      />
    </>
  );
}
