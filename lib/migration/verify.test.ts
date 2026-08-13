import { describe, expect, it } from "vitest";

import { type CheckResult, formatResult, summarize } from "./verify.ts";

function check(overrides: Partial<CheckResult> = {}): CheckResult {
  return { name: "something", ok: true, detail: "0 problems", ...overrides };
}

describe("summarize", () => {
  it("passes when every check passes", () => {
    expect(summarize([check(), check()])).toEqual({
      total: 2,
      passed: 2,
      failed: 0,
      warnings: 0,
      exitCode: 0,
    });
  });

  it("blocks the cutover on a failing check", () => {
    const summary = summarize([check(), check({ ok: false })]);
    expect(summary.failed).toBe(1);
    expect(summary.exitCode).toBe(1);
  });

  it("treats a check as blocking unless it opts out", () => {
    // Severity is omitted far more often than it is set, so the safe reading of
    // a missing value has to be "this blocks".
    expect(summarize([check({ ok: false })]).exitCode).toBe(1);
  });

  it("lets an advisory finding be reported without failing the run", () => {
    const summary = summarize([check({ ok: false, severity: "warning" }), check()]);
    expect(summary).toMatchObject({ passed: 1, failed: 0, warnings: 1, exitCode: 0 });
  });

  it("still fails when a warning accompanies a real defect", () => {
    const summary = summarize([
      check({ ok: false, severity: "warning" }),
      check({ ok: false }),
    ]);
    expect(summary.exitCode).toBe(1);
    expect(summary.warnings).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it("handles an empty run", () => {
    expect(summarize([])).toMatchObject({ total: 0, exitCode: 0 });
  });
});

describe("formatResult", () => {
  it("labels each outcome distinctly", () => {
    expect(formatResult(check())).toContain("PASS");
    expect(formatResult(check({ ok: false }))).toContain("FAIL");
    expect(formatResult(check({ ok: false, severity: "warning" }))).toContain("WARN");
  });

  it("keeps the detail visible on a passing check", () => {
    // The measurement is the useful part; hiding it on success would mean
    // trusting a green tick with no number behind it.
    expect(formatResult(check({ detail: "484 decisions" }))).toContain("484 decisions");
  });
});
