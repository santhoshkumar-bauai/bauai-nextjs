export const companyWebsitePattern =
  /^(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:[/?#][^\s]*)?$/i;

export function normalizeCompanyWebsite(value: string) {
  const input = value.trim();
  if (!companyWebsitePattern.test(input)) return null;

  try {
    const url = new URL(
      /^https?:\/\//i.test(input) ? input : `https://${input}`,
    );
    const domain = url.hostname.toLowerCase().replace(/^www\./, "");
    return {
      website: url.toString().replace(/\/$/, ""),
      domain,
    };
  } catch {
    return null;
  }
}
