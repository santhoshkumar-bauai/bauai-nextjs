/**
 * Full-agent E2E: a REAL chat turn through buildFillAgentGraph — real Gemini
 * (fill_agent role), real sandbox, real Mongo session + checkpoints, real S3.
 * No HTTP/auth layer; this is the library seam the routes call.
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types <this file>
 */
import { createHash, randomUUID } from "node:crypto";

import { HumanMessage } from "@langchain/core/messages";
import { config as loadEnv } from "dotenv";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

loadEnv({ path: ".env.local", quiet: true });

const { buildPdfManifest } = await import(
  "../../lib/ai/dora/fill/pdf/manifest.ts"
);
const { buildFillAgentRunContext } = await import(
  "../../lib/ai/fill-agent/context.ts"
);
const { buildFillAgentGraph } = await import(
  "../../lib/ai/fill-agent/graph.ts"
);
const { createFillSession, getFillSession, deleteFillSession } = await import(
  "../../lib/ai/fill-agent/store.ts"
);
const { ensureFillSessionThread, purgeFillSessionThread } = await import(
  "../../lib/ai/fill-agent/threads.ts"
);
const { getSandboxClient } = await import(
  "../../lib/ai/fill-agent/sandbox-client.ts"
);
const { buildObjectKey, putObjectBuffer, deleteObject } = await import(
  "../../lib/storage/s3.ts"
);

const A4: [number, number] = [595.28, 841.89];
const H = A4[1];

async function digitalSample(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.1, 0.1, 0.12);
  // Enough template prose that BOTH classifiers see a text layer: the Node
  // gate wants >120 chars/page, the Python one >50 chars total.
  const prose = [
    "Angebot für die Ausschreibung — bitte alle Felder vollständig ausfüllen.",
    "Die Angaben werden im Rahmen der Eignungsprüfung nach VOB/A verwendet.",
    "Unvollständige Angebote können vom Verfahren ausgeschlossen werden.",
    "Bitte tragen Sie die Werte gut leserlich in die vorgesehenen Felder ein.",
  ];
  // Kept well clear of the entry boxes so the post-check's padded region
  // around a filled box never catches template prose.
  prose.forEach((line, index) => {
    page.drawText(line, { x: 72, y: H - 36 - index * 12, size: 9, font, color: ink });
  });
  page.drawText("Firmenname:", { x: 72, y: H - 114, size: 9, font, color: ink });
  page.drawRectangle({ x: 140, y: H - 124, width: 240, height: 20, borderColor: ink, borderWidth: 1 });
  page.drawText("Umsatz 2025:", { x: 72, y: H - 150, size: 9, font, color: ink });
  page.drawRectangle({ x: 140, y: H - 160, width: 240, height: 20, borderColor: ink, borderWidth: 1 });
  return Buffer.from(await doc.save());
}

async function main() {
  const bytes = await digitalSample();
  const manifest = await buildPdfManifest(bytes);
  console.log("manifest:", manifest.classification.documentClass, manifest.manifestHash.slice(0, 12));

  const companyId = "64a0000000000000000000aa"; // synthetic smoke tenant
  const companyContext = {
    userId: "fill-agent-e2e",
    name: "Smoke",
    email: "smoke@example.com",
    role: "member",
    company: { _id: companyId, name: "Smoke GmbH" },
  } as never;

  const s3Key = buildObjectKey({
    companyId,
    category: "fill-agent-poc",
    fileName: "smoke-form.pdf",
    uniqueId: randomUUID(),
  });
  await putObjectBuffer(s3Key, bytes, "application/pdf");

  const { ObjectId } = await import("mongodb");
  const tenantId = new ObjectId(companyId);
  const session = await createFillSession({
    tenantId,
    createdBy: "fill-agent-e2e",
    source: {
      s3Key,
      fileName: "smoke-form.pdf",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    },
    pdf: {
      documentClass: manifest.classification.documentClass,
      pageCount: manifest.classification.pageCount,
      manifestHash: manifest.manifestHash,
      acroFieldCount: manifest.classification.acroFieldCount,
    },
    maxFillIterations: 5,
    targetScore: 0.95,
  });
  const thread = await ensureFillSessionThread({
    tenantId,
    sessionId: session._id!,
    userId: "fill-agent-e2e",
  });
  console.log("session:", String(session._id), "thread:", thread.threadKey);

  const cleanup = async () => {
    const current = await getFillSession(tenantId, session._id!);
    if (current?.sandboxSessionId) {
      await getSandboxClient().deleteSession(current.sandboxSessionId).catch(() => {});
    }
    if (current?.output) await deleteObject(current.output.s3Key).catch(() => {});
    await deleteObject(s3Key).catch(() => {});
    await purgeFillSessionThread(tenantId, session._id!);
    await deleteFillSession(tenantId, session._id!);
  };

  try {
    const turns = [
      "Fülle dieses Formular aus: Firmenname ist Muster Bau GmbH, Umsatz 2025 ist 2450000.",
      "Ja, bitte fahre fort und fülle das Formular vollständig aus.",
      "Weiter bitte.",
    ];
    for (const [index, userText] of turns.entries()) {
      const ctx = await buildFillAgentRunContext({
        companyContext,
        sessionIdHex: String(session._id),
        locale: "de",
      });
      if (!ctx) throw new Error("context build failed");
      const graph = await buildFillAgentGraph(ctx);

      console.log(`\n=== turn ${index + 1}: ${userText}`);
      const stream = graph.streamEvents(
        { messages: [new HumanMessage(userText)] },
        { version: "v2", configurable: { thread_id: thread.threadKey } },
      );
      let finalText = "";
      for await (const event of stream as AsyncIterable<{
        event: string;
        name?: string;
        data?: { chunk?: { text?: string } };
      }>) {
        if (event.event === "on_tool_start") console.log(`  [tool] ${event.name}`);
        if (event.event === "on_chat_model_stream") {
          const text = event.data?.chunk?.text;
          if (typeof text === "string") finalText += text;
        }
      }
      console.log("  [assistant]", finalText.slice(-600).trim());

      const after = await getFillSession(tenantId, session._id!);
      console.log(
        `  [session] status=${after?.status} fields=${after?.fieldmap.length} ` +
          `iterations=${after?.fillIterations} score=${after?.score} ` +
          `openQ=${after?.openQuestions.length} output=${after?.output ? "yes" : "no"}`,
      );
      if (after?.status === "filled" || after?.status === "escalated") break;
    }

    const final = await getFillSession(tenantId, session._id!);
    const pass =
      final?.status === "filled" &&
      final.output != null &&
      (final.score ?? 0) >= 0.95 &&
      final.fieldmap.length >= 2;
    console.log(pass ? "\nAGENT E2E PASSED" : "\nAGENT E2E FAILED");
    console.log("final:", JSON.stringify({
      status: final?.status,
      score: final?.score,
      iterations: final?.fillIterations,
      fields: final?.fieldmap.map((field) => ({ id: field.id, value: field.value })),
      output: final?.output?.s3Key,
    }, null, 1));
    process.exitCode = pass ? 0 : 1;
  } finally {
    await cleanup();
  }
}

await main();
process.exit();
