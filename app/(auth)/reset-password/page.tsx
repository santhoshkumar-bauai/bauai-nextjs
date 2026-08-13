import type { Metadata } from "next";

import { ResetPasswordForm } from "@/components/auth/reset-password-form";

export const metadata: Metadata = { title: "Reset password" };

export default async function ResetPasswordPage({
  searchParams,
}: PageProps<"/reset-password">) {
  // Better Auth's /reset-password/:token callback validates the token first and
  // lands here with either ?token=… or ?error=INVALID_TOKEN. Both absences mean
  // the same thing to the form: there is no usable token.
  const { token } = await searchParams;
  return (
    <ResetPasswordForm token={typeof token === "string" ? token : undefined} />
  );
}
