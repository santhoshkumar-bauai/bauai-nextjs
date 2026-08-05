import { redirect } from "next/navigation";

import { LogoUploader } from "@/components/settings/logo-uploader";
import { SectionForm } from "@/components/settings/section-form";
import { getSettingsData } from "@/lib/company/settings-data";
import { COMPANY_INFO_SECTION } from "@/lib/company/settings-sections";

export default async function CompanyInfoPage() {
  const data = await getSettingsData();
  if (!data) redirect("/dashboard");

  return (
    <>
      <LogoUploader initialLogoUrl={data.profile.logoUrl} canEdit={data.canEdit} />
      <SectionForm
        profile={data.profile}
        config={COMPANY_INFO_SECTION}
        canEdit={data.canEdit}
      />
    </>
  );
}
