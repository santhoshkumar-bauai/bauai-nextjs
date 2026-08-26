/**
 * Iris block smoke test: build one block per tool, outside a request.
 *
 *   npm run poc:iris:smoke -- <tenderId>
 *
 * Exists because a block failure is invisible from the UI: `render()` collapses
 * every throw to one neutral card so a provider error can never reach the
 * browser, which is right for users and useless for debugging. This runs the
 * same builders with the stack intact.
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

// The raw driver, not the Mongoose model: `models/company.ts` uses named
// imports from mongoose, which is CJS and blows up under `node --experimental-
// strip-types`. Every field the tools read is a plain property, so a driver
// document stands in for the hydrated one.
const { mongoDatabase } = await import("../../lib/db/mongodb.ts");
const { buildIrisRunContext } = await import("../../lib/ai/iris/context.ts");
const { resolveVisibleTender } = await import("../../lib/ai/agent/context.ts");
const { getTenderCoverage, lookupCpvCodes } = await import("../../lib/ai/agent/workspace.ts");
const { getTenderOverview } = await import("../../lib/ai/overview/service.ts");
const { buildIrisTools } = await import("../../lib/ai/iris/tools.ts");

// `--company <substring>` matters more than it looks: half the block builders
// hash or embed the company profile, so a failure can be specific to ONE
// tenant's data and invisible against whichever company sorts first.
const companyArg = process.argv.indexOf("--company");
const companyFilter =
  companyArg > -1 && process.argv[companyArg + 1]
    ? { name: { $regex: process.argv[companyArg + 1], $options: "i" } }
    : {};
const company = await mongoDatabase.collection("companies").findOne(companyFilter);
if (!company) throw new Error("no company matched");
console.log(`[iris-smoke] company: ${company.name}`);

const ctx = buildIrisRunContext({
  companyContext: {
    userId: company.members?.[0]?.userId ?? "smoke",
    name: "smoke",
    email: "smoke@example.com",
    role: company.members?.[0]?.role ?? "admin",
    company,
  } as never,
  locale: "en",
});

const step = async (label: string, run: () => Promise<unknown>) => {
  try {
    await run();
    console.log(`[iris-smoke] ${label}: OK`);
  } catch (error) {
    console.error(`[iris-smoke] ${label}: FAILED`);
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  }
};

const tenderIdHex = process.argv[2];
if (tenderIdHex) {
  const scope = await resolveVisibleTender(tenderIdHex);
  if (!scope) throw new Error(`tender ${tenderIdHex} is not visible`);
  const detail = scope.tenderDetail;
  console.log(`[iris-smoke] tender: ${detail.title?.slice(0, 70)}`);
  console.log(
    `[iris-smoke] description=${detail.description?.length ?? 0} chars, ` +
      `lots=${detail.lots.length}, cpv=${detail.cpvCodes.length}, regions=${detail.regions.length}`,
  );

  // Each dependency separately, so a failure names its own frame.
  await step("getTenderCoverage", () => getTenderCoverage(ctx, scope.tenderId));
  await step("getTenderOverview", () => getTenderOverview(scope.tenderId));
  await step("lookupCpvCodes", () =>
    lookupCpvCodes({ codes: detail.cpvCodes.slice(0, 6), locale: "en", limit: 6 }),
  );
}

const tools = buildIrisTools(ctx);
const inputs: Record<string, unknown> = {
  show_portfolio_metrics: {},
  show_opportunity_feed: { limit: 3 },
  show_pipeline_board: {},
  show_company_snapshot: {},
  explore_cpv_codes: { query: "road", limit: 5 },
  offer_filters: {},
  ...(tenderIdHex
    ? {
        show_tender_spotlight: { tenderId: tenderIdHex },
        show_bid_verdict: { tenderId: tenderIdHex },
        show_requirements: { tenderId: tenderIdHex },
        show_deadlines: { tenderId: tenderIdHex },
        show_tender_documents: { tenderId: tenderIdHex },
        search_evidence: { scope: "tender", tenderId: tenderIdHex, query: "Vertragsstrafe", k: 3 },
      }
    : {}),
};

for (const [name, input] of Object.entries(inputs)) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) continue;
  await step(name, async () => {
    const ack = await tool.invoke(input as never);
    console.log(`[iris-smoke]   ack: ${String(ack).slice(0, 220)}`);
  });
}

process.exit(0);
