import { describe, expect, it } from "vitest";

/**
 * End-to-end Document Brief test against the real local stack: atlas-local
 * Mongo, the real S3 bucket, and the real Gemini API. Picks an existing ready
 * workspace document (tender-linked preferred) and runs the whole pipeline —
 * context, text extraction, grounding, the bilingual structured call, citation
 * resolution and persistence. The produced brief is REAL and stays stored, so
 * the Dora panel shows it on next open. Opt-in:
 *
 *   AI_INTEGRATION=1 npm run test -- lib/ai/dora/brief.integration
 */
const enabled = process.env.AI_INTEGRATION === "1";

describe.skipIf(!enabled)("generateBrief (integration)", () => {
  it("produces a stored bilingual brief for a real workspace document", async () => {
    const { connectMongoose } = await import("../../db/mongoose.ts");
    const { WorkspaceDocument } = await import(
      "../../../models/workspace-document.ts"
    );
    const { Company } = await import("../../../models/company.ts");
    await connectMongoose();

    // Tender-linked first — that exercises the full grounding path.
    const document =
      (await WorkspaceDocument.findOne({
        deletedAt: null,
        state: "ready",
        tenderId: { $ne: null },
      }).lean()) ??
      (await WorkspaceDocument.findOne({ deletedAt: null, state: "ready" }).lean());
    expect(document, "no ready workspace document to analyze").not.toBeNull();

    const company = await Company.findById(document!.companyId);
    expect(company, "workspace document's company missing").not.toBeNull();
    const memberUserId = company!.members?.[0]?.userId ?? "integration-test";

    const companyContext = {
      userId: memberUserId,
      name: "Integration Test",
      email: "integration@test.local",
      role: "admin",
      company: company!,
    } as never;

    const { buildDoraRunContext } = await import("./context.ts");
    const ctx = await buildDoraRunContext({
      companyContext,
      documentIdHex: String(document!._id),
      locale: "en",
    });
    expect(ctx).not.toBeNull();
    expect(ctx!.document.version).not.toBeNull();

    const { getWorkspaceDocumentText } = await import("./document-text.ts");
    const text = await getWorkspaceDocumentText(ctx!.document, ctx!.tenantId);
    // eslint-disable-next-line no-console
    console.log("[dora-integration] text:", {
      file: ctx!.document.fileName,
      tenderLinked: Boolean(ctx!.tender),
      status: text.status,
      source: text.source,
      note: text.note,
      chars: text.chars,
    });

    const { claimBriefRun, getBriefRun } = await import("./brief-runs.ts");
    const claimed = await claimBriefRun({
      tenantId: ctx!.tenantId,
      documentId: ctx!.document.documentId,
      userId: memberUserId,
    });
    expect(claimed, "another brief run is in flight").not.toBeNull();

    const { generateBrief, getBriefState } = await import("./brief.ts");
    await generateBrief({ ctx: ctx!, refresh: false });

    const run = await getBriefRun(ctx!.tenantId, ctx!.document.documentId);
    expect(run?.error ?? null).toBeNull();
    expect(run?.status).toBe("done");

    const state = await getBriefState(ctx!);
    expect(state).not.toBeNull();
    expect(state!.stale).toBe(false);
    const en = state!.doc.brief.en as { documentType?: string; requiredActions?: unknown[] };
    const de = state!.doc.brief.de as { documentType?: string };
    expect(en.documentType).toBeTruthy();
    expect(de.documentType).toBeTruthy();

    const { serializeBrief } = await import("./brief.ts");
    const wire = serializeBrief(state!.doc, state!.stale, "en");
    // eslint-disable-next-line no-console
    console.log("[dora-integration] brief:", {
      documentType: wire.documentType,
      purpose: wire.purpose,
      actions: wire.requiredActions.length,
      values: wire.suggestedValues.length,
      requirements: wire.keyRequirements.length,
      deadlines: wire.deadlines.length,
      risks: wire.risks.length,
      citedItems: [
        ...wire.keyRequirements,
        ...wire.requiredActions,
        ...wire.suggestedValues,
      ].filter((item) => item.citations.length > 0).length,
    });

    const { closeIngestionClient } = await import("../../ingestion/db/client.ts");
    await closeIngestionClient();
  }, 300_000);
});
