import { CreditCard, Sparkles, UsersRound } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { card, formatDate, panelIcon } from "@/components/settings/settings-ui";
import { getSettingsData } from "@/lib/company/settings-data";

export default async function BillingPage() {
  const data = await getSettingsData();
  if (!data) redirect("/dashboard");
  const t = await getTranslations("Settings");

  return (
    <div className="mx-auto my-7 grid max-w-[920px] gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(270px,.65fr)]">
      <section className={`${card} flex flex-col gap-11 p-6`}>
        <div className="flex items-start gap-3">
          <span className={panelIcon}>
            <CreditCard size={19} />
          </span>
          <div>
            <h2 className="m-0 text-base font-bold">{t("billing.plan")}</h2>
            <p className="mt-1 text-xs text-[#85818c]">{t("billing.subtitle")}</p>
          </div>
        </div>
        <div className="grid gap-1.5">
          <strong className="text-[25px] text-[#6516dc]">
            {t("billing.trial")}
          </strong>
          <span className="text-xs text-[#837f89]">
            {t("billing.trialDescription")} {formatDate(data.trialEndsAt)}
          </span>
        </div>
      </section>
      <section className={`${card} flex flex-col p-6`}>
        <h2 className="m-0 text-base font-bold">{t("billing.usage")}</h2>
        <p className="mt-1 text-xs leading-relaxed text-[#85818c]">
          {t("billing.previewDescription")}
        </p>
        <div className="my-6 grid gap-3">
          <span className="flex items-center gap-2 text-xs text-[#53505a]">
            <UsersRound size={17} className="text-[#7b25d5]" />
            {t("billing.seats")}
            <b className="ml-auto text-[#26232a]">1 / 10</b>
          </span>
          <span className="flex items-center gap-2 text-xs text-[#53505a]">
            <Sparkles size={17} className="text-[#7b25d5]" />
            AI actions<b className="ml-auto text-[#26232a]">0 / 100</b>
          </span>
        </div>
      </section>
    </div>
  );
}
