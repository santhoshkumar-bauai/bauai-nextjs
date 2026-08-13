"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { CheckCircle2, CircleAlert, LockKeyhole } from "lucide-react";
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

export function ResetPasswordForm({ token }: { token?: string }) {
  const t = useTranslations("ResetPassword");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    const confirmation = String(form.get("confirmPassword") ?? "");

    if (password.length < 8) {
      setError(t("validation"));
      return;
    }
    if (password !== confirmation) {
      setError(t("mismatch"));
      return;
    }

    setLoading(true);
    const result = await authClient.resetPassword({
      newPassword: password,
      token,
    });

    if (result.error) {
      setError(result.error.message || t("error"));
      setLoading(false);
      return;
    }

    // Every session was revoked along with the reset, so there is nothing to
    // redirect into — the reader signs in again with the new password.
    setDone(true);
    setLoading(false);
  }

  // The callback link lands here without a token when it was already used,
  // expired, or tampered with. Nothing to submit — send them back for a new one.
  if (!token) {
    return (
      <section className={`${authCard} ${authStatus}`}>
        <span className="mx-auto grid size-[62px] place-items-center rounded-[18px] bg-red-50 text-[#c23737]">
          <CircleAlert size={28} />
        </span>
        <h1>{t("invalidTitle")}</h1>
        <p>{t("invalidDescription")}</p>
        <Link
          className="mt-6 inline-block text-[13px] font-bold text-[#5000a8] no-underline"
          href="/forgot-password"
        >
          {t("requestNewLink")}
        </Link>
      </section>
    );
  }

  if (done) {
    return (
      <section className={`${authCard} ${authStatus}`} aria-live="polite">
        <span className="mx-auto grid size-[62px] place-items-center rounded-[18px] bg-[#eafaf0] text-[#18864b]">
          <CheckCircle2 size={28} />
        </span>
        <h1>{t("successTitle")}</h1>
        <p>{t("successDescription")}</p>
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
      <label className={authField}>
        {t("confirmPassword")}
        <span className={authInputShell}>
          <LockKeyhole aria-hidden="true" size={18} />
          <Input
            name="confirmPassword"
            type="password"
            placeholder={t("confirmPasswordPlaceholder")}
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
        {loading ? t("saving") : t("save")}
      </Button>
      <p className={authPrompt}>
        {t("remembered")} <Link href="/login">{t("signIn")}</Link>
      </p>
    </form>
  );
}
