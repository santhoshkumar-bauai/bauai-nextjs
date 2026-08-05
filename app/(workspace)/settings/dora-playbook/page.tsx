import { Sparkles } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { card, panelIcon } from "@/components/settings/settings-ui";

export default async function DoraPlaybookPage() {
  const t = await getTranslations("Settings");
  const cards: Array<[string, string]> = [
    ["analysis", t("dora.cards.analysis")],
    ["drafting", t("dora.cards.drafting")],
    ["review", t("dora.cards.review")],
  ];

  return (
    <div className="mx-auto my-7 max-w-[980px]">
      <section className={`${card} flex items-start gap-3.5 p-6 sm:items-center`}>
        <span className={panelIcon}>
          <Sparkles size={23} />
        </span>
        <div className="flex-1">
          <h2 className="m-0 text-base font-bold">{t("dora.title")}</h2>
          <p className="mt-1 text-xs leading-relaxed text-[#85818c]">
            {t("dora.subtitle")}
          </p>
        </div>
      </section>
      <p className="my-5 max-w-[620px] text-xs leading-relaxed text-[#85818c]">
        {t("dora.previewDescription")}
      </p>
      <div className="grid gap-4 md:grid-cols-3">
        {cards.map(([key, title], index) => (
          <article key={key} className={`${card} p-5`}>
            <span className="grid size-[29px] place-items-center rounded-lg bg-[#f0e5ff] text-xs font-extrabold text-[#6817cd]">
              {index + 1}
            </span>
            <h3 className="mt-7 text-sm font-bold">{title}</h3>
            <p className="mt-1 text-xs leading-relaxed text-[#85818c]">
              {t("dora.description")}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}
