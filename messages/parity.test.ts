import { readFileSync } from "node:fs";
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

/**
 * Duplicate keys within one object are silently collapsed by `JSON.parse` —
 * last one wins — so a whole block of translations can vanish while both
 * catalogs still agree. Walk the raw text to catch it.
 */
function duplicateKeys(source: string): string[] {
  const duplicates: string[] = [];
  const path: string[] = [];
  const seen: Set<string>[] = [];
  let index = 0;

  const readString = (): string => {
    let value = "";
    index++; // opening quote
    while (index < source.length) {
      const char = source[index];
      if (char === "\\") {
        value += source[index + 1];
        index += 2;
        continue;
      }
      if (char === '"') {
        index++;
        return value;
      }
      value += char;
      index++;
    }
    return value;
  };

  let expectKey = false;
  while (index < source.length) {
    const char = source[index];
    if (char === "{") {
      seen.push(new Set());
      expectKey = true;
      index++;
    } else if (char === "}") {
      seen.pop();
      path.pop();
      expectKey = false;
      index++;
    } else if (char === "[") {
      expectKey = false;
      index++;
    } else if (char === "]") {
      path.pop();
      index++;
    } else if (char === ",") {
      expectKey = seen.length > 0;
      path.pop();
      index++;
    } else if (char === '"') {
      const value = readString();
      if (expectKey) {
        const scope = seen[seen.length - 1];
        if (scope.has(value)) duplicates.push([...path, value].join("."));
        scope.add(value);
        path.push(value);
        expectKey = false;
      }
    } else {
      index++;
    }
  }

  return duplicates;
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

  it.each(["en", "de"])("%s.json has no duplicate keys", (locale) => {
    const source = readFileSync(new URL(`./${locale}.json`, import.meta.url), "utf8");
    const duplicates = duplicateKeys(source);
    expect(duplicates, `duplicated in ${locale}.json: ${duplicates.join(", ")}`).toEqual(
      [],
    );
  });
});
