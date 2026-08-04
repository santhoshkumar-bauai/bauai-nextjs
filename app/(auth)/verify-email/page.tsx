import type { Metadata } from "next";
import { VerificationResult } from "@/components/auth/verification-result";

export const metadata: Metadata = { title: "Verify email" };

export default async function VerifyEmailPage({ searchParams }: PageProps<"/verify-email">) {
  const { error } = await searchParams;
  return <VerificationResult error={typeof error === "string" ? error : undefined} />;
}
