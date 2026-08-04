import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { OnboardingForm } from "@/components/onboarding/onboarding-form";
import { auth } from "@/lib/auth";
import { connectMongoose } from "@/lib/db/mongoose";
import { AccountProfile } from "@/models/account-profile";

export const metadata: Metadata = { title: "Onboarding" };

export default async function OnboardingPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/login");
  if (!session.user.emailVerified) redirect("/sign-up");

  await connectMongoose();
  const profile = await AccountProfile.findOne({
    userId: session.user.id,
  }).lean();
  if (profile?.onboardingCompleted) redirect("/dashboard");

  return (
    <main className="grid min-h-svh place-items-center bg-[radial-gradient(circle_at_18%_0%,#f1e7fb_0,transparent_32%),#f7f6f8] px-5 py-12">
      <OnboardingForm />
    </main>
  );
}
