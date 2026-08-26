/**
 * Fill-agent routing dry-run.
 *
 *   npm run ai:fill:roles
 *
 * Prints where each fill-agent role would route — provider, model, Azure
 * deployment, reasoning effort, output budget — and runs the same startup
 * validation the server runs, WITHOUT any network call or token spend. This is
 * the acceptance check for tier routing: prove the right tier serves the right
 * node before a single request is made.
 *
 * No logger import on purpose: the ingestion logger eagerly requires
 * MONGODB_URI at import, and this script must run in a bare checkout.
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { FILL_AGENT_ROLES, fillAgentForceTier, roleMaxOutputTokens, roleReasoningEffort, aiEnv } =
  await import("../lib/ai/config/env.ts");
const { resolveRole, resolveAzureDeployment } = await import("../lib/ai/gateway/config.ts");
const { assertFillAgentRolesResolvable } = await import("../lib/ai/config/validate-roles.ts");

const TIER_BY_ROLE: Record<string, string> = {
  fill_agent: "luna (orchestrator)",
  fill_agent_plan: "sol",
  fill_agent_critique: "terra",
  fill_agent_repair: "luna",
};

const forceTier = fillAgentForceTier();
console.log("fill-agent model routing (dry run — no tokens spent)\n");
if (forceTier) {
  console.log(`!! AI_FILL_AGENT_FORCE_TIER=${forceTier} is ACTIVE — all roles pinned to one tier.\n`);
}

const rows: string[][] = [["role", "tier", "provider:model", "deployment", "effort", "maxTokens"]];
for (const role of FILL_AGENT_ROLES) {
  let providerModel = "-";
  let deployment = "-";
  try {
    const ref = resolveRole(role);
    providerModel = `${ref.provider}:${ref.model}`;
    if (ref.provider === "azure") {
      const resolved = resolveAzureDeployment(ref.model);
      const explicit = aiEnv().azureDeployments[ref.model];
      deployment = explicit ? resolved : `${resolved} (implicit AZURE_OPENAI_DEPLOYMENT fallback)`;
    }
  } catch (error) {
    providerModel = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
  }
  rows.push([
    role,
    TIER_BY_ROLE[role] ?? "-",
    providerModel,
    deployment,
    String(roleReasoningEffort(role) ?? "-"),
    String(roleMaxOutputTokens(role)),
  ]);
}

const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
for (const [n, row] of rows.entries()) {
  console.log(row.map((cell, i) => cell.padEnd(widths[i] + 2)).join(""));
  if (n === 0) console.log(widths.map((w) => "-".repeat(w + 2)).join(""));
}

console.log("");
try {
  assertFillAgentRolesResolvable();
  console.log("startup validation: OK — every fill role is servable as configured.");
} catch (error) {
  console.error(
    `startup validation: FAILED\n${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
