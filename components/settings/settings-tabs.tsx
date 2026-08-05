"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { SETTINGS_TABS } from "@/lib/company/settings-sections";

/** Route-based settings tabs. The Company Information tab stays active for any of its sub-section routes. */
export function SettingsTabs() {
  const pathname = usePathname();

  const isActive = (tab: (typeof SETTINGS_TABS)[number]) => {
    if (tab.match === "company") {
      // Company Information covers /settings and every company sub-section, but
      // not the sibling top-level tabs.
      const others = SETTINGS_TABS.filter((item) => item.match !== "company");
      return !others.some((item) => pathname.startsWith(item.href));
    }
    return pathname === tab.href || pathname.startsWith(`${tab.href}/`);
  };

  return (
    <div
      className="mx-auto flex max-w-[1320px] overflow-x-auto border-b border-[#dfdfe4]"
      role="tablist"
      aria-label="Settings"
    >
      {SETTINGS_TABS.map((tab) => {
        const active = isActive(tab);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            role="tab"
            aria-selected={active}
            className={`shrink-0 border-b-2 px-4 py-3 text-[13px] font-bold ${
              active
                ? "border-[#6e16cf] text-[#5f13bb]"
                : "border-transparent text-[#4a4850] hover:text-[#5f13bb]"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
