"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { LockKeyhole, Mail } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

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
      email: String(form.get("email") ?? "").trim().toLowerCase(),
      password: String(form.get("password") ?? ""),
      callbackURL: "/onboarding",
    });

    if (result.error) {
      setError(result.error.status === 403 ? t("verifyFirst") : result.error.message || t("error"));
      setLoading(false);
      return;
    }

    router.push("/onboarding");
    router.refresh();
  }

  return (
    <form className="login-card" onSubmit={submit} noValidate>
      <div className="login-heading"><h1>{t("welcome")}</h1><p>{t("description")}</p></div>
      <label className="field-label">
        {t("email")}
        <span className="input-shell"><Mail aria-hidden="true" size={18} /><Input name="email" type="email" placeholder={t("emailPlaceholder")} autoComplete="email" required /></span>
      </label>
      <label className="field-label">
        <span className="label-row"><span>{t("password")}</span><Link href="/forgot-password">{t("forgotPassword")}</Link></span>
        <span className="input-shell"><LockKeyhole aria-hidden="true" size={18} /><Input name="password" type="password" placeholder={t("passwordPlaceholder")} autoComplete="current-password" required /></span>
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <Button type="submit" size="lg" className="sign-in-button" disabled={loading}>{loading ? t("signingIn") : t("signIn")}</Button>
      <p className="register-prompt">{t("noAccount")} <Link href="/sign-up">{t("createAccount")}</Link></p>
    </form>
  );
}
