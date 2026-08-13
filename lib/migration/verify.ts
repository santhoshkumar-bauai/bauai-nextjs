/**
 * Result types for the migration verification pass.
 *
 * Every integrity check the migration has relied on so far was typed by hand
 * into a mongosh session. That is fine for a rehearsal and useless as a cutover
 * gate: it is not repeatable, not reviewable, and nothing fails loudly. This
 * gives the checks a shape, a severity, and an exit code.
 *
 * Severity matters because not every finding should block a cutover. A dangling
 * reference is a defect; a company whose profile is thin is worth knowing about
 * but is how the legacy data arrived.
 */

export type CheckSeverity = "error" | "warning";

export interface CheckResult {
  name: string;
  ok: boolean;
  /** What was measured, shown whether or not the check passed. */
  detail: string;
  /** Defaults to "error" — a failing check blocks unless it says otherwise. */
  severity?: CheckSeverity;
}

export interface VerifySummary {
  total: number;
  passed: number;
  /** Failing checks that block a cutover. */
  failed: number;
  /** Failing checks that are advisory only. */
  warnings: number;
  /** 0 when nothing blocking failed. */
  exitCode: 0 | 1;
}

export function summarize(results: CheckResult[]): VerifySummary {
  let passed = 0;
  let failed = 0;
  let warnings = 0;

  for (const result of results) {
    if (result.ok) {
      passed += 1;
      continue;
    }
    if ((result.severity ?? "error") === "warning") warnings += 1;
    else failed += 1;
  }

  return {
    total: results.length,
    passed,
    failed,
    warnings,
    exitCode: failed > 0 ? 1 : 0,
  };
}

/** Fixed-width lines so a long check list stays scannable. */
export function formatResult(result: CheckResult): string {
  const label = result.ok
    ? "PASS"
    : (result.severity ?? "error") === "warning"
      ? "WARN"
      : "FAIL";
  return `  ${label}  ${result.name.padEnd(46)} ${result.detail}`;
}
