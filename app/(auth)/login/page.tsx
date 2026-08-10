import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { LoginForm } from "@/components/auth/login-form";
import { auth } from "@/lib/auth";

export const metadata: Metadata = { title: "Login" };

export default async function LoginPage() {
  // Already signed in: send the reader into the app instead of asking for
  // credentials they have already given. /onboarding is the app's single entry
  // gate — the same landing the login form uses — and forwards on to the
  // dashboard, or back to sign-up for an unverified address.
  const session = await auth.api.getSession({ headers: await headers() });
  if (session?.user) redirect("/onboarding");

  return <LoginForm />;
}
