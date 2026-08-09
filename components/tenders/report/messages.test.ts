import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import de from "../../../messages/de.json";
import en from "../../../messages/en.json";

/**
 * Every `Tenders.report` key the UI asks for must exist in BOTH catalogs.
 *
 * A missing key is invisible to typecheck, lint and the parity test — parity
 * only proves en and de agree, and two catalogs agree perfectly well on not
 * having a key. It surfaces as a MISSING_MESSAGE console error in the browser,
 * which is far too late. This walks the component sources instead, so the
 * guard cannot drift out of date as the UI grows.
 */

const NAMESPACE = "Tenders.report";

/** Files that render report copy. */
const SOURCES = [
  ...readdirSync(join(process.cwd(), "components/tenders/report"))
    .filter((name) => /\.tsx?$/.test(name) && !name.includes(".test."))
    .map((name) => join("components/tenders/report", name)),
  join("components/chat", "tender-report-panel.tsx"),
  join("components/chat", "clara-chat-workspace.tsx"),
  join("components/tenders", "tender-detail-page.tsx"),
  join("components/tenders/detail", "clara-assistant.tsx"),
];

/**
 * Static `t("key")` calls, for whichever local name the file bound
 * `useTranslations("Tenders.report")` to. Template-literal (dynamic) keys are
 * deliberately skipped — the enum families below cover those.
 */
function staticKeysIn(source: string): string[] {
  const binding = new RegExp(
    `const\\s+(\\w+)\\s*=\\s*useTranslations\\(\\s*"${NAMESPACE}"\\s*\\)`,
  ).exec(source);
  if (!binding) return [];

  const calls = new RegExp(`\\b${binding[1]}\\(\\s*"([^"]+)"`, "g");
  return [...source.matchAll(calls)].map((match) => match[1]);
}

function resolve(catalog: unknown, path: string): unknown {
  let node: unknown = catalog;
  for (const segment of `${NAMESPACE}.${path}`.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Keys built at runtime from a union — enumerated so they are checked too. */
const DYNAMIC_FAMILIES: Record<string, string[]> = {
  sections: [
    "executiveSummary",
    "recommendation",
    "scores",
    "overview",
    "keyFacts",
    "timeline",
    "requirements",
    "commercials",
    "companyFit",
    "risks",
    "competition",
    "bidStrategy",
    "actionPlan",
    "openQuestions",
    "documentChecklist",
    "dataGaps",
    "sources",
    "coverage",
  ],
  "recommendation.decision": ["bid", "conditional", "no_bid"],
  "requirements.categories": [
    "eligibility",
    "technical",
    "financial",
    "insurance",
    "certification",
    "reference",
    "formal",
    "other",
  ],
  "requirements.statuses": ["met", "partial", "gap", "unknown"],
  "risks.levels": ["low", "medium", "high"],
  "actionPlan.priorities": ["immediate", "high", "normal"],
  "checklist.sources": ["company_has", "must_obtain", "must_produce", "unknown"],
  stages: ["gathering", "analyzing", "translating", "saving"],
  languages: ["en", "de"],
};

const CATALOGS: Array<[string, unknown]> = [
  ["en", en],
  ["de", de],
];

describe("Tenders.report messages", () => {
  const referenced = new Set<string>();
  for (const file of SOURCES) {
    for (const key of staticKeysIn(readFileSync(join(process.cwd(), file), "utf8"))) {
      referenced.add(key);
    }
  }

  it("finds the keys the components actually reference", () => {
    // Guards the scanner itself: if a rename made it match nothing, every
    // assertion below would pass vacuously.
    expect(referenced.size).toBeGreaterThan(15);
    expect(referenced).toContain("recentReports");
    expect(referenced).toContain("browseTenders");
    expect(referenced).toContain("openReport");
  });

  it.each(CATALOGS)("resolves every referenced key in %s", (_locale, catalog) => {
    const missing = [...referenced].filter(
      (key) => typeof resolve(catalog, key) !== "string",
    );
    expect(missing).toEqual([]);
  });

  it.each(CATALOGS)("resolves every dynamic key family in %s", (_locale, catalog) => {
    const missing: string[] = [];
    for (const [family, values] of Object.entries(DYNAMIC_FAMILIES)) {
      for (const value of values) {
        if (typeof resolve(catalog, `${family}.${value}`) !== "string") {
          missing.push(`${family}.${value}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
