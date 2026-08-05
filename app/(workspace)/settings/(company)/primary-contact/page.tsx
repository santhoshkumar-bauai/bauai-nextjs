import { redirect } from "next/navigation";

import { SectionForm } from "@/components/settings/section-form";
import { getSettingsData } from "@/lib/company/settings-data";
import { PRIMARY_CONTACT_SECTION } from "@/lib/company/settings-sections";

export default async function PrimaryContactPage() {
  const data = await getSettingsData();
  if (!data) redirect("/dashboard");
  return (
    <SectionForm
      profile={data.profile}
      config={PRIMARY_CONTACT_SECTION}
      canEdit={data.canEdit}
    />
  );
}
