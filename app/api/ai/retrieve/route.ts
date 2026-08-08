import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";
import { z } from "zod";

import { hybridRetrieveChunks } from "@/lib/ai/retrieval/hybrid";
import { forCompanyContext } from "@/lib/ai/tenant/repository";
import { getCompanyContext } from "@/lib/company/context";

const bodySchema = z.object({
  query: z.string().min(2).max(1000),
  /** Chunk retrieval is always tender-scoped (roadmap §17.4). */
  tenderId: z.string().refine((v) => ObjectId.isValid(v), "invalid tenderId"),
  documentRecordId: z.string().min(1).optional(),
  docClass: z.string().min(1).optional(),
  language: z.string().min(2).max(5).optional(),
  k: z.number().int().min(1).max(20).default(10),
  mode: z.enum(["keyword", "vector", "hybrid"]).default("hybrid"),
});

/**
 * Internal hybrid-retrieval endpoint over tender document chunks. The tenant
 * scope comes from the authenticated company context — never from the body.
 */
export async function POST(request: Request) {
  const context = await getCompanyContext();
  if (!context) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    const chunks = await hybridRetrieveChunks({
      text: body.query,
      k: body.k,
      mode: body.mode,
      filters: {
        tenantId: forCompanyContext(context).value,
        tenderId: new ObjectId(body.tenderId),
        documentRecordId: body.documentRecordId,
        docClass: body.docClass,
        language: body.language,
      },
    });

    return NextResponse.json({
      mode: body.mode,
      count: chunks.length,
      chunks: chunks.map((chunk) => ({
        chunkId: String(chunk.chunkId),
        documentRecordId: chunk.documentRecordId,
        fileName: chunk.fileName,
        sectionPath: chunk.sectionPath,
        text: chunk.text,
        legalRefs: chunk.legalRefs,
        anchor: chunk.anchor,
        scores: chunk.scores,
        rank: chunk.rank,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Retrieval failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
