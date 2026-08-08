import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";

import { getAiCollections } from "@/lib/ai/db/collections";
import { PROMPT_VERSION } from "@/lib/ai/extraction/prompts";
import {
  EXTRACTION_SCHEMA_NAMES,
  EXTRACTION_SCHEMAS,
} from "@/lib/ai/extraction/schemas";
import { computeCorpusHash } from "@/lib/ai/extraction/store";
import { extractSchemaJobId } from "@/lib/ai/queue/jobs";
import { getCompanyContext } from "@/lib/company/context";

/**
 * Per-schema extraction progress for the CURRENT corpus identity — reads the
 * ai_index_state ledger, which is the only place RUNNING and FAILED are
 * visible (the extractions collection holds completed records only).
 */
export async function GET(
  _request: Request,
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

  const { chunks, aiIndexState } = await getAiCollections();
  const chunkCount = await chunks.countDocuments({ tenderId });
  if (chunkCount === 0) {
    return NextResponse.json({ corpusReady: false, corpusHash: null, schemas: {} });
  }

  const corpusHash = await computeCorpusHash(tenderId);
  const stateIds = EXTRACTION_SCHEMA_NAMES.map((schemaName) => ({
    schemaName,
    stateId: extractSchemaJobId({
      tenderId: id,
      schemaName,
      schemaVersion: EXTRACTION_SCHEMAS[schemaName].schemaVersion,
      promptVersion: PROMPT_VERSION,
      corpusHash,
    }),
  }));

  const states = await aiIndexState
    .find({ _id: { $in: stateIds.map((s) => s.stateId) } })
    .toArray();
  const byId = new Map(states.map((state) => [state._id, state]));

  const schemas: Record<string, { status: string; error: string | null }> = {};
  for (const { schemaName, stateId } of stateIds) {
    const state = byId.get(stateId);
    schemas[schemaName] = {
      status: state?.status ?? "NOT_STARTED",
      error: state?.error ?? null,
    };
  }

  return NextResponse.json({ corpusReady: true, corpusHash, schemas });
}
