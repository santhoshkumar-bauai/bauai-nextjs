import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeOnlyOfficeDownloadUrl } from "./callback";

const original = { ...process.env };

describe("ONLYOFFICE callback URL normalization", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_DS_URL = "https://docs.example.test";
    process.env.DS_INTERNAL_URL = "http://onlyoffice";
    process.env.INTERNAL_APP_URL = "http://web:3000";
    process.env.PUBLIC_APP_URL = "https://app.example.test";
    process.env.OO_JWT_SECRET = "test-onlyoffice-secret-32-characters";
    process.env.OO_AI_JWT_SECRET = "test-plugin-secret-32-characters-long";
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("rewrites the public Document Server origin to its internal origin", () => {
    expect(normalizeOnlyOfficeDownloadUrl("https://docs.example.test/cache/files/a.docx?x=1"))
      .toBe("http://onlyoffice/cache/files/a.docx?x=1");
  });

  it("keeps an internal Document Server URL", () => {
    expect(normalizeOnlyOfficeDownloadUrl("http://onlyoffice/cache/a.docx"))
      .toBe("http://onlyoffice/cache/a.docx");
  });

  it("rejects SSRF origins and non-http protocols", () => {
    expect(() => normalizeOnlyOfficeDownloadUrl("https://attacker.test/a.docx")).toThrow();
    expect(() => normalizeOnlyOfficeDownloadUrl("file:///etc/passwd")).toThrow();
  });
});
