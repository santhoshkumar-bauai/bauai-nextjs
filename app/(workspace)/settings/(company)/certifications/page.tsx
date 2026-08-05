import { redirect } from "next/navigation";

import { CertificationsForm } from "@/components/settings/certifications-form";
import { getSettingsData } from "@/lib/company/settings-data";

export default async function CertificationsPage() {
  const data = await getSettingsData();
  if (!data) redirect("/dashboard");
  return <CertificationsForm profile={data.profile} canEdit={data.canEdit} />;
}
