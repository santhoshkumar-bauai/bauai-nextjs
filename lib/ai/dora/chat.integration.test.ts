import { describe, expect, it } from "vitest";

/**
 * End-to-end Dora chat turn against the real local stack: the shared tool
 * loop with Dora's graph, tools and prompt, MongoDB checkpoints, real Gemini.
 * The conversation is cleared afterwards so the panel starts pristine. Opt-in:
 *
 *   AI_INTEGRATION=1 npm run test -- lib/ai/dora/chat.integration
 */
const enabled = process.env.AI_INTEGRATION === "1";

describe.skipIf(!enabled)("Dora chat turn (integration)", () => {
  it("answers a document question through the tool loop", async () => {
    const { connectMongoose } = await import("../../db/mongoose.ts");
    const { WorkspaceDocument } = await import(
      "../../../models/workspace-document.ts"
    );
    const { Company } = await import("../../../models/company.ts");
    await connectMongoose();

    const document =
      (await WorkspaceDocument.findOne({
        deletedAt: null,
        state: "ready",
        tenderId: { $ne: null },
      }).lean()) ??
      (await WorkspaceDocument.findOne({ deletedAt: null, state: "ready" }).lean());
    expect(document).not.toBeNull();
    const company = await Company.findById(document!.companyId);
    const memberUserId = company!.members?.[0]?.userId ?? "integration-test";

    const { buildDoraRunContext } = await import("./context.ts");
    const ctx = await buildDoraRunContext({
      companyContext: {
        userId: memberUserId,
        name: "Integration Test",
        email: "integration@test.local",
        role: "admin",
        company: company!,
      } as never,
      documentIdHex: String(document!._id),
      locale: "en",
    });
    expect(ctx).not.toBeNull();

    const { ensureDocumentThread, clearDocumentThread } = await import("./threads.ts");
    const thread = await ensureDocumentThread({
      tenantId: ctx!.tenantId,
      documentId: ctx!.document.documentId,
      userId: memberUserId,
    });

    try {
      const { runChatTurn } = await import("../agent/service.ts");
      const { buildDoraGraph } = await import("./graph.ts");
      const tools: string[] = [];
      const { assistantMessage } = await runChatTurn({
        ctx: ctx!,
        threadId: thread._id!,
        threadKey: thread.threadKey,
        userText:
          "What is this document, and what is the first thing I should fill in?",
        buildGraph: () => buildDoraGraph(ctx!),
        callbacks: { onToolStart: (name) => tools.push(name) },
      });

      console.log("[dora-chat-integration]", {
        status: assistantMessage.status,
        tools,
        citations: assistantMessage.citations.length,
        answer: assistantMessage.content.slice(0, 300),
      });
      expect(assistantMessage.status).toBe("complete");
      expect(assistantMessage.content.trim().length).toBeGreaterThan(0);
    } finally {
      await clearDocumentThread(ctx!.tenantId, ctx!.document.documentId);
      const { closeIngestionClient } = await import("../../ingestion/db/client.ts");
      await closeIngestionClient();
    }
  }, 300_000);
});
