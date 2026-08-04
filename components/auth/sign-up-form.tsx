"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { CheckCircle2, LockKeyhole, Mail, UserRound } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

export function SignUpForm() {
  const t = useTranslations("SignUp");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sentTo, setSentTo] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);

    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    const password = String(form.get("password") ?? "");

    if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) {
      setError(t("validation"));
      setLoading(false);
      return;
    }

    const result = await authClient.signUp.email({
      name,
      email,
      password,
      callbackURL: "/verify-email",
    });

    if (result.error) {
      setError(result.error.message || t("error"));
    } else {
      setSentTo(email);
    }
    setLoading(false);
  }

  if (sentTo) {
    return (
      <section className="login-card auth-status-card" aria-live="polite">
        <span className="status-icon"><Mail size={28} /></span>
        <h1>{t("checkEmailTitle")}</h1>
        <p>{t("checkEmailDescription", { email: sentTo })}</p>
        <p className="status-note">{t("checkSpam")}</p>
        <Link className="status-link" href="/login">{t("backToLogin")}</Link>
      </section>
    );
  }

  return (
    <form className="login-card" onSubmit={submit} noValidate>
      <div className="login-heading">
        <h1>{t("title")}</h1>
        <p>{t("description")}</p>
      </div>
      <label className="field-label">
        {t("name")}
        <span className="input-shell"><UserRound aria-hidden="true" size={18} /><Input name="name" placeholder={t("namePlaceholder")} autoComplete="name" required /></span>
      </label>
      <label className="field-label">
        {t("email")}
        <span className="input-shell"><Mail aria-hidden="true" size={18} /><Input name="email" type="email" placeholder={t("emailPlaceholder")} autoComplete="email" required /></span>
      </label>
      <label className="field-label">
        {t("password")}
        <span className="input-shell"><LockKeyhole aria-hidden="true" size={18} /><Input name="password" type="password" placeholder={t("passwordPlaceholder")} autoComplete="new-password" minLength={8} required /></span>
      </label>
      <p className="password-hint"><CheckCircle2 size={14} />{t("passwordHint")}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <Button type="submit" size="lg" className="sign-in-button" disabled={loading}>{loading ? t("creating") : t("createAccount")}</Button>
      <p className="register-prompt">{t("haveAccount")} <Link href="/login">{t("signIn")}</Link></p>
    </form>
  );
}
