"use client";

import {
  BadgeCheck,
  Building2,
  ClipboardList,
  FileText,
  Landmark,
  Mail,
  MapPin,
  ShieldCheck,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { card } from "@/components/settings/settings-ui";
import { COMPANY_NAV } from "@/lib/company/settings-sections";

const ICONS: Record<string, LucideIcon> = {
  Building2,
  ClipboardList,
  MapPin,
  Mail,
  UsersRound,
  Landmark,
  ShieldCheck,
  BadgeCheck,
  FileText,
};

/** Left-hand navigation for the Company Information sub-sections (each its own route). */
export function CompanySidebar({ completion }: { completion: number }) {
  const pathname = usePathname();
  const t = useTranslations("Settings");

  return (
    <aside className={`${card} hidden self-start p-[18px] lg:block`}>
      <div className="flex justify-between text-xs font-bold text-[#393641]">
        <span>{t("sidebar.profileSetup")}</span>
        <strong className="text-[#6816c8]">{completion}%</strong>
      </div>
      <div className="my-3 h-1.5 rounded-full bg-[#eceaf2]">
        <span
          className="block h-full rounded-full bg-[#721ae0]"
          style={{ width: `${completion}%` }}
        />
      </div>
      <div className="grid gap-1">
        {COMPANY_NAV.map((item) => {
          const Icon = ICONS[item.icon] ?? Building2;
          const href = `/settings/${item.slug}`;
          const active = pathname === href;
          return (
            <Link
              key={item.slug}
              href={href}
              className={`flex min-w-0 items-center gap-2 rounded-[9px] px-2 py-2 text-left text-[11px] ${
                active ? "bg-[#f3eaff] font-bold text-[#5e12bf]" : "text-[#3f3c46] hover:bg-[#f7f4fc]"
              }`}
            >
              <span
                className={`grid size-[25px] shrink-0 place-items-center rounded-[7px] ${
                  active ? "bg-[#e5d0ff] text-[#6814d2]" : "bg-[#f1f2f7] text-[#7a8292]"
                }`}
              >
                <Icon size={16} />
              </span>
              {t(`sidebar.${item.labelKey}`)}
            </Link>
          );
        })}
      </div>
    </aside>
  );
}
