import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";

import { HumanMessage } from "@langchain/core/messages";

import { withProviderStructuredOutput } from "../../../agent/structured.ts";
import { getChatModel } from "../../../agent/model.ts";
import { resolveRole } from "../../../gateway/config.ts";
import { roleMaxOutputTokens, roleReasoningEffort } from "../../../config/env.ts";
import { buildDiscoveryPrompt } from "./analyze-pdf.ts";
import { buildPdfManifest } from "./manifest.ts";
import { pdfFileBlock, shouldSendPdfNatively } from "./model-input.ts";
import { PDF_FILL_DISCOVERY_JSON_SCHEMA, pdfFillDiscoverySchema } from "./schema-pdf.ts";

/**
 * PDF fill discovery against the live provider.
 *
 * Opt-in (`AI_INTEGRATION=1`) like the other integration suites, and it needs a
 * real committed PDF in the workspace — pass its id in `VERIFY_PDF_DOC`.
 *
 * What it is actually checking is the combination the Azure migration changed:
 * a native PDF sent as a file block (vision), through a STRICT json_schema
 * whose optional properties had to be null-widened. Before that fix, `rect` and
 * `value` were declared required and non-nullable while Zod had them nullable,
 * so on a field it could not fill the model was being told to invent one.
 */
const RUN = process.env.AI_INTEGRATION === "1" && Boolean(process.env.VERIFY_PDF_DOC);

describe.skipIf(!RUN)("pdf fill discovery (live)", () => {
  it("discovers fillable fields and may legitimately return null values", async () => {
    const { MongoClient } = await import("mongodb");
    const { getObjectBuffer } = await import("@/lib/storage/s3");

    const mongo = new MongoClient(process.env.MONGODB_URI!);
    await mongo.connect();
    try {
      const db = mongo.db(process.env.MONGODB_DB || "bauai");
      const documentId = new ObjectId(process.env.VERIFY_PDF_DOC!);
      const document = await db.collection("workspacedocuments").findOne({ _id: documentId });
      const version = await db
        .collection("workspacedocumentversions")
        .findOne({ documentId, state: "committed" }, { sort: { createdAt: -1 } });
      expect(version, "no committed version for VERIFY_PDF_DOC").toBeTruthy();

      const bytes = await getObjectBuffer(String(version!.s3Key));
      const manifest = await buildPdfManifest(bytes);
      const native = shouldSendPdfNatively({
        bytes: bytes.byteLength,
        documentClass: manifest.classification.documentClass,
      });

      const ref = resolveRole("dora_pdf_fill");
      console.log(
        `[pdf] ${document?.fileName} ${bytes.byteLength}B class=${manifest.classification.documentClass} ` +
          `acroform=${manifest.acroFields.length} lines=${manifest.lines.length} native=${native}`,
      );
      console.log(
        `[pdf] role → ${ref.provider}:${ref.model} effort=${roleReasoningEffort("dora_pdf_fill")} ` +
          `maxOut=${roleMaxOutputTokens("dora_pdf_fill")}`,
      );

      const prompt = buildDiscoveryPrompt({
        manifest,
        profileLines: [
          "Company: Wirl Ing GmbH",
          "Legal form: GmbH",
          "Address: Musterstrasse 12, 10115 Berlin",
          "Managing director: Santhosh Kumar",
          "VAT id: DE123456789",
          "Trades: Sanitaer, Heizung, Tiefbau",
        ],
        corpusLines: [],
        native,
      });

      const model = await getChatModel({
        role: "dora_pdf_fill",
        maxOutputTokens: 16_384,
        temperature: 0,
      });
      const structured = withProviderStructuredOutput(model, PDF_FILL_DISCOVERY_JSON_SCHEMA, {
        name: "pdf_document_fill_discovery",
        role: "dora_pdf_fill",
      });

      const started = Date.now();
      const raw = native
        ? await structured.invoke([
            new HumanMessage({
              content: [
                { type: "text", text: prompt },
                pdfFileBlock(bytes, String(document?.fileName ?? "document.pdf")),
              ] as never,
            }),
          ])
        : await structured.invoke(prompt);

      // The real contract: Zod, not the provider schema.
      const discovery = pdfFillDiscoverySchema.parse(raw);
      console.log(`[pdf] ${Math.round((Date.now() - started) / 1000)}s → ${discovery.fields.length} fields`);
      for (const field of discovery.fields.slice(0, 10)) {
        console.log(
          `  [${field.kind}] ${field.label.slice(0, 40).padEnd(40)} ` +
            `value=${JSON.stringify(field.value)?.slice(0, 30)} conf=${field.confidence}`,
        );
      }
      const nullValues = discovery.fields.filter((f) => f.value === null).length;
      const nullRects = discovery.fields.filter((f) => f.rect === null).length;
      console.log(`[pdf] value=null ${nullValues}/${discovery.fields.length}, rect=null ${nullRects}/${discovery.fields.length}`);

      expect(discovery.fields.length).toBeGreaterThan(0);
      // Every field must name something real in the document.
      for (const field of discovery.fields) {
        expect(field.label.length).toBeGreaterThan(0);
        expect(["acroform", "overlay_text", "overlay_vision"]).toContain(field.kind);
      }
    } finally {
      await mongo.close();
    }
  }, 300_000);
});
