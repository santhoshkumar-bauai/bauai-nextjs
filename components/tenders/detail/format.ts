/** Currency formatting for tender values, in the viewer's locale. */
export function formatValue(
  amount: string | null,
  currency: string | null,
  locale: string,
): string | null {
  if (!amount) return null;
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return null;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency || "EUR",
      maximumFractionDigits: 0,
    }).format(numeric);
  } catch {
    return `${numeric.toLocaleString(locale)} ${currency ?? ""}`.trim();
  }
}
