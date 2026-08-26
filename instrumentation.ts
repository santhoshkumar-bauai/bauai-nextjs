/**
 * Next.js server-start hook (runs once per server instance). Validates the
 * fill-agent's tiered model routing so a missing deployment mapping fails at
 * boot with a named fix, not on the first fill request.
 *
 * Guards: only the Node runtime (edge/browser bundles skip), and never during
 * `next build` — build workers initiate server instances too, and a CI build
 * without Azure env must stay green.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { assertFillAgentRolesResolvable } = await import("./lib/ai/config/validate-roles.ts");
  assertFillAgentRolesResolvable();
}
