import { redirect } from "next/navigation";

// Company Information is the first tab; its canonical URL is the company-info
// sub-section so every section has its own path.
export default function SettingsIndexPage() {
  redirect("/settings/company-info");
}
