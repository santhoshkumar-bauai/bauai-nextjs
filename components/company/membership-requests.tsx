"use client";

import { useEffect, useState } from "react";
import { Check, LoaderCircle, UserRoundPlus, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

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
      .then(async (response) => ({ response, result: await response.json() as { items?: MembershipRequest[] } }))
      .then(({ response, result }) => { if (current && response.ok) setItems(result.items || []); })
      .catch(() => { if (current) setError(t("loadError")); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
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

  if (loading) return <div className="membership-requests-loading"><LoaderCircle size={17} />{t("loading")}</div>;
  if (!items.length && !error) return null;

  return (
    <section className="membership-requests-card">
      <header><span><UserRoundPlus size={19} /></span><div><h2>{t("title")}</h2><p>{t("description")}</p></div></header>
      <div className="membership-request-list">
        {items.map((item) => (
          <article key={item.userId}>
            <div><strong>{item.email}</strong><span>{t("requested", { date: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(item.requestedAt)) })}</span></div>
            <div className="membership-request-actions">
              <Button type="button" variant="outline" disabled={reviewing === item.userId} onClick={() => review(item.userId, "reject")}><X size={15} />{t("reject")}</Button>
              <Button type="button" disabled={reviewing === item.userId} onClick={() => review(item.userId, "approve")}>
                {reviewing === item.userId ? <LoaderCircle className="combobox-spinner-inline" size={15} /> : <Check size={15} />}{t("approve")}
              </Button>
            </div>
          </article>
        ))}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}
