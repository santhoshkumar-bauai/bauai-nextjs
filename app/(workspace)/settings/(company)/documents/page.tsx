import { redirect } from "next/navigation";

import { DocumentsManager } from "@/components/settings/documents-manager";
import { getSettingsData } from "@/lib/company/settings-data";

export default async function DocumentsPage() {
  const data = await getSettingsData();
  if (!data) redirect("/dashboard");
  return <DocumentsManager initialFiles={data.files} canEdit={data.canEdit} />;
}
