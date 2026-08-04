"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { LockKeyhole, Mail } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import {
  authCard,
  authError,
  authField,
  authHeading,
  authInputShell,
  authPrompt,
  authSubmit,
} from "./auth-tailwind";

export function LoginForm() {
  const t = useTranslations("Login");
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);
    const form = new FormData(event.currentTarget);
    const result = await authClient.signIn.email({
      email: String(form.get("email") ?? "")
        .trim()
        .toLowerCase(),
      password: String(form.get("password") ?? ""),
      callbackURL: "/onboarding",
    });

    if (result.error) {
      setError(
        result.error.status === 403
          ? t("verifyFirst")
          : result.error.message || t("error"),
      );
      setLoading(false);
      return;
    }

    router.push("/onboarding");
    router.refresh();
  }

  return (
    <form className={authCard} onSubmit={submit} noValidate>
      <div className={authHeading}>
        <h1>{t("welcome")}</h1>
        <p>{t("description")}</p>
      </div>
      <label className={authField}>
        {t("email")}
        <span className={authInputShell}>
          <Mail aria-hidden="true" size={18} />
          <Input
            name="email"
            type="email"
            placeholder={t("emailPlaceholder")}
            autoComplete="email"
            required
          />
        </span>
      </label>
      <label className={authField}>
        <span className="flex items-center justify-between gap-2.5">
          <span>{t("password")}</span>
          <Link
            className="font-normal text-[#8b8796] no-underline hover:text-[#5000a8]"
            href="/forgot-password"
          >
            {t("forgotPassword")}
          </Link>
        </span>
        <span className={authInputShell}>
          <LockKeyhole aria-hidden="true" size={18} />
          <Input
            name="password"
            type="password"
            placeholder={t("passwordPlaceholder")}
            autoComplete="current-password"
            required
          />
        </span>
      </label>
      {error && (
        <p className={authError} role="alert">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" className={authSubmit} disabled={loading}>
        {loading ? t("signingIn") : t("signIn")}
      </Button>
      <p className={authPrompt}>
        {t("noAccount")} <Link href="/sign-up">{t("createAccount")}</Link>
      </p>
    </form>
  );
}
