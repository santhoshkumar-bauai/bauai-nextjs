"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { CheckCircle2, LockKeyhole, Mail, UserRound } from "lucide-react";
import { useTranslations } from "next-intl";

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
  authStatus,
  authSubmit,
} from "./auth-tailwind";

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
    const email = String(form.get("email") ?? "")
      .trim()
      .toLowerCase();
    const password = String(form.get("password") ?? "");

    if (
      name.length < 2 ||
      !/^\S+@\S+\.\S+$/.test(email) ||
      password.length < 8
    ) {
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
      <section className={`${authCard} ${authStatus}`} aria-live="polite">
        <span className="mx-auto grid size-[62px] place-items-center rounded-[18px] bg-[#f2e8fb] text-[#6515b7]">
          <Mail size={28} />
        </span>
        <h1>{t("checkEmailTitle")}</h1>
        <p>{t("checkEmailDescription", { email: sentTo })}</p>
        <p className="mt-3! text-xs! text-[#99929f]!">{t("checkSpam")}</p>
        <Link
          className="mt-6 inline-block text-[13px] font-bold text-[#5000a8] no-underline"
          href="/login"
        >
          {t("backToLogin")}
        </Link>
      </section>
    );
  }

  return (
    <form className={authCard} onSubmit={submit} noValidate>
      <div className={authHeading}>
        <h1>{t("title")}</h1>
        <p>{t("description")}</p>
      </div>
      <label className={authField}>
        {t("name")}
        <span className={authInputShell}>
          <UserRound aria-hidden="true" size={18} />
          <Input
            name="name"
            placeholder={t("namePlaceholder")}
            autoComplete="name"
            required
          />
        </span>
      </label>
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
        {t("password")}
        <span className={authInputShell}>
          <LockKeyhole aria-hidden="true" size={18} />
          <Input
            name="password"
            type="password"
            placeholder={t("passwordPlaceholder")}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </span>
      </label>
      <p className="mt-2.5 flex items-center gap-1.5 text-xs text-[#87818d] [&_svg]:text-[#6f25bd]">
        <CheckCircle2 size={14} />
        {t("passwordHint")}
      </p>
      {error && (
        <p className={authError} role="alert">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" className={authSubmit} disabled={loading}>
        {loading ? t("creating") : t("createAccount")}
      </Button>
      <p className={authPrompt}>
        {t("haveAccount")} <Link href="/login">{t("signIn")}</Link>
      </p>
    </form>
  );
}
