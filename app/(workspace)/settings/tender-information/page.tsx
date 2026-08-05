import { redirect } from "next/navigation";

import { SectionForm } from "@/components/settings/section-form";
import { getSettingsData } from "@/lib/company/settings-data";
import {
  PROJECT_SIZE_SECTION,
  TENDER_INFO_SECTION,
} from "@/lib/company/settings-sections";

export default async function TenderInformationPage() {
  const data = await getSettingsData();
  if (!data) redirect("/dashboard");
  return (
    <div className="mx-auto mt-7 grid max-w-[1056px] gap-[18px]">
      <SectionForm
        profile={data.profile}
        config={TENDER_INFO_SECTION}
        canEdit={data.canEdit}
      />
      <SectionForm
        profile={data.profile}
        config={PROJECT_SIZE_SECTION}
        canEdit={data.canEdit}
      />
    </div>
  );
}
