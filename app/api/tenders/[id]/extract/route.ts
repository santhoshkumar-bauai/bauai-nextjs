import { randomUUID } from "node:crypto";

import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAiCollections } from "@/lib/ai/db/collections";
import { PROMPT_VERSION } from "@/lib/ai/extraction/prompts";
import {
  EXTRACTION_SCHEMA_NAMES,
  EXTRACTION_SCHEMAS,
} from "@/lib/ai/extraction/schemas";
import { computeCorpusHash } from "@/lib/ai/extraction/store";
import {
  extractSchemaJobId,
  type ExtractSchemaJob,
} from "@/lib/ai/queue/jobs";
import { AI_QUEUES, getAiQueue } from "@/lib/ai/queue/queues";
import { getCompanyContext } from "@/lib/company/context";

const bodySchema = z.object({
  schemas: z.array(z.enum(EXTRACTION_SCHEMA_NAMES)).min(1).optional(),
});

/**
 * Enqueues citation-verified structured extraction for a tender (on-demand
 * per the pilot design — never automatic). Idempotent: a schema whose
 * (version, prompt, corpus) identity already completed is skipped; a corpus
 * change (new fetched document) re-enables it.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await getCompanyContext();
  if (!context) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid tender id" }, { status: 400 });
  }
  const tenderId = new ObjectId(id);

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }
  const schemaNames = parsed.data.schemas ?? [...EXTRACTION_SCHEMA_NAMES];

  const { chunks, aiIndexState } = await getAiCollections();
  const chunkCount = await chunks.countDocuments({ tenderId });
  if (chunkCount === 0) {
    return NextResponse.json(
      {
        error:
          "This tender has no processed documents yet. Fetch and index documents first.",
      },
      { status: 409 },
    );
  }

  const corpusHash = await computeCorpusHash(tenderId);
  const queue = getAiQueue(AI_QUEUES.extraction);
  const enqueued: string[] = [];
  const skipped: string[] = [];

  for (const schemaName of schemaNames) {
    const schema = EXTRACTION_SCHEMAS[schemaName];
    const job: ExtractSchemaJob = {
      kind: "extract_schema",
      tenderId: id,
      schemaName,
      schemaVersion: schema.schemaVersion,
      promptVersion: PROMPT_VERSION,
      corpusHash,
      actorId: context.userId,
      correlationId: randomUUID(),
      attempt: 0,
    };
    const jobId = extractSchemaJobId(job);

    const state = await aiIndexState.findOne({ _id: jobId });
    if (state?.status === "DONE") {
      skipped.push(schemaName);
      continue;
    }
    await queue.add("extract_schema", job, { jobId });
    enqueued.push(schemaName);
  }

  return NextResponse.json({ enqueued, skipped, corpusHash });
}
