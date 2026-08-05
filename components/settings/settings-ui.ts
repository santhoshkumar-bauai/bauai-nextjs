/** Shared Tailwind class strings + small formatters for the settings UI. */

export const card =
  "rounded-[18px] border border-[#ebeaf0] bg-white shadow-[0_12px_34px_rgba(37,32,51,.04)]";
export const panelIcon =
  "grid size-9 shrink-0 place-items-center rounded-[11px] bg-[#f2e8ff] text-[#741bd3]";
export const fieldLabel = "grid gap-2 text-xs font-bold text-[#29262e]";
export const fieldInput =
  "w-full rounded-[9px] border border-[#e1e1e8] bg-white px-3.5 py-3 text-xs font-normal text-[#29262e] outline-none transition-colors focus:border-[#8b5cf6] focus:ring-2 focus:ring-[#ede9fe] disabled:bg-[#fafbfe] disabled:text-[#a0a0aa]";
export const primaryButton = "bg-[#6516dc] text-white hover:bg-[#5711c2]";

export function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

export function initial(value: string) {
  return (
    value
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "BA"
  );
}
