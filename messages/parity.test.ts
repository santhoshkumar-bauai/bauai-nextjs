import { describe, expect, it } from "vitest";

import de from "./de.json";
import en from "./en.json";

/** Every leaf key must exist in both locales — a missing key throws at runtime. */
function leafKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("message catalogs", () => {
  it("en and de have identical key sets", () => {
    const enKeys = leafKeys(en).sort();
    const deKeys = leafKeys(de).sort();
    const missingInDe = enKeys.filter((key) => !deKeys.includes(key));
    const missingInEn = deKeys.filter((key) => !enKeys.includes(key));
    expect(missingInDe, `missing in de.json: ${missingInDe.join(", ")}`).toEqual([]);
    expect(missingInEn, `missing in en.json: ${missingInEn.join(", ")}`).toEqual([]);
  });
});
