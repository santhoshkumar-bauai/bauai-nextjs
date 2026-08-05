import { redirect } from "next/navigation";

import { SectionForm } from "@/components/settings/section-form";
import { getSettingsData } from "@/lib/company/settings-data";
import { MAILING_ADDRESS_SECTION } from "@/lib/company/settings-sections";

export default async function MailingAddressPage() {
  const data = await getSettingsData();
  if (!data) redirect("/dashboard");
  return (
    <SectionForm
      profile={data.profile}
      config={MAILING_ADDRESS_SECTION}
      canEdit={data.canEdit}
    />
  );
}
