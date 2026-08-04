"use client";

import { useEffect, useState } from "react";
import { Check, LoaderCircle, UserRoundPlus, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { authError } from "@/components/auth/auth-tailwind";

type MembershipRequest = { userId: string; email: string; requestedAt: string };

export function MembershipRequests() {
  const t = useTranslations("Dashboard.membershipRequests");
  const locale = useLocale();
  const [items, setItems] = useState<MembershipRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let current = true;
    fetch("/api/company/membership-requests")
      .then(async (response) => ({
        response,
        result: (await response.json()) as { items?: MembershipRequest[] },
      }))
      .then(({ response, result }) => {
        if (current && response.ok) setItems(result.items || []);
      })
      .catch(() => {
        if (current) setError(t("loadError"));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [t]);

  const review = async (userId: string, action: "approve" | "reject") => {
    setReviewing(userId);
    setError("");
    try {
      const response = await fetch("/api/company/membership-requests", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, action }),
      });
      if (!response.ok) {
        setError(t("reviewError"));
        return;
      }
      setItems((current) => current.filter((item) => item.userId !== userId));
    } finally {
      setReviewing(null);
    }
  };

  if (loading)
    return (
      <div className="mx-auto mt-7 inline-flex items-center gap-2 text-[13px] text-[#7b7482]">
        <LoaderCircle className="animate-spin" size={17} />
        {t("loading")}
      </div>
    );
  if (!items.length && !error) return null;

  return (
    <section className="mx-auto mt-[34px] w-[min(100%,720px)] rounded-[18px] border border-[#e4dde9] bg-white p-[22px] text-left shadow-[0_18px_45px_rgba(44,21,75,.08)]">
      <header className="flex items-start gap-3 border-b border-[#f0ebf2] pb-[17px]">
        <span className="grid size-[38px] place-items-center rounded-[11px] bg-[#f3eafa] text-[#6515b7]">
          <UserRoundPlus size={19} />
        </span>
        <div>
          <h2 className="m-0 text-base font-bold">{t("title")}</h2>
          <p className="mt-1 mb-0 text-xs leading-[1.45] text-[#7b7482]">
            {t("description")}
          </p>
        </div>
      </header>
      <div>
        {items.map((item) => (
          <article
            className="flex items-center justify-between gap-[18px] border-b border-[#f2edf4] px-0.5 py-4 last:border-b-0 last:pb-0"
            key={item.userId}
          >
            <div className="grid min-w-0 gap-1">
              <strong className="overflow-hidden text-[13px] text-ellipsis">
                {item.email}
              </strong>
              <span className="text-[11px] text-[#8b8490]">
                {t("requested", {
                  date: new Intl.DateTimeFormat(locale, {
                    dateStyle: "medium",
                  }).format(new Date(item.requestedAt)),
                })}
              </span>
            </div>
            <div className="flex gap-2">
              <Button
                className="h-9 gap-1.5 rounded-lg px-3 text-xs"
                type="button"
                variant="outline"
                disabled={reviewing === item.userId}
                onClick={() => review(item.userId, "reject")}
              >
                <X size={15} />
                {t("reject")}
              </Button>
              <Button
                className="h-9 gap-1.5 rounded-lg px-3 text-xs"
                type="button"
                disabled={reviewing === item.userId}
                onClick={() => review(item.userId, "approve")}
              >
                {reviewing === item.userId ? (
                  <LoaderCircle className="animate-spin" size={15} />
                ) : (
                  <Check size={15} />
                )}
                {t("approve")}
              </Button>
            </div>
          </article>
        ))}
      </div>
      {error && (
        <p className={authError} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
