import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { auth } from "@/lib/auth";
import { connectMongoose } from "@/lib/db/mongoose";
import { AccountProfile } from "@/models/account-profile";

export default async function DashboardPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/login");
  await connectMongoose();
  const profile = await AccountProfile.findOne({ userId: session.user.id }).lean();
  if (!profile?.onboardingCompleted) redirect("/onboarding");
  const t = await getTranslations("Dashboard");

  return (
    <main className="dashboard-placeholder">
      <span>BAU AI</span>
      <h1>{t("welcome", { name: session.user.name })}</h1>
      <p>{t("description")}</p>
    </main>
  );
}
