import { NextResponse } from "next/server";

import { aiOperationRequestSchema } from "@/lib/onlyoffice/ai-schema";
import { generateDocumentProposal } from "@/lib/onlyoffice/ai-service";
import { onlyOfficeAiEnabled } from "@/lib/onlyoffice/env";
import { authorizePluginScope, pluginCorsHeaders } from "@/lib/onlyoffice/plugin-auth";
import { bearerToken, verifyAiAccessToken } from "@/lib/onlyoffice/tokens";

export function OPTIONS(request: Request) {
  const headers = pluginCorsHeaders(request);
  return headers ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 });
}

export async function POST(request: Request) {
  const headers = pluginCorsHeaders(request);
  if (!headers) return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });
  if (!onlyOfficeAiEnabled()) {
    return NextResponse.json({ error: "AI is disabled" }, { status: 503, headers });
  }
  try {
    const token = bearerToken(request);
    if (!token) throw new Error("missing token");
    const access = await verifyAiAccessToken(token);
    const parsed = aiOperationRequestSchema.safeParse(await request.json());
    if (!parsed.success || parsed.data.documentId !== access.documentId) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400, headers });
    }
    const document = await authorizePluginScope(access);
    if (!document) return NextResponse.json({ error: "not_found" }, { status: 404, headers });
    const { ObjectId } = await import("mongodb");
    const generate = () => generateDocumentProposal({
      request: parsed.data,
      document,
      companyId: new ObjectId(access.companyId),
      userId: access.userId,
    });
    if (request.headers.get("accept")?.includes("text/event-stream")) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(`event: status\ndata: ${JSON.stringify({ stage: "generating" })}\n\n`));
          try {
            const result = await generate();
            controller.enqueue(encoder.encode(`event: proposal\ndata: ${JSON.stringify(result)}\n\n`));
          } catch {
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: "operation_failed" })}\n\n`));
          } finally {
            controller.close();
          }
        },
      });
      const streamHeaders = new Headers(headers);
      streamHeaders.set("content-type", "text/event-stream; charset=utf-8");
      streamHeaders.set("cache-control", "no-store");
      return new Response(stream, { headers: streamHeaders });
    }
    const result = await generate();
    return NextResponse.json(result, { headers });
  } catch (error) {
    console.error("ONLYOFFICE AI operation failed", error);
    return NextResponse.json({ error: "operation_failed" }, { status: 500, headers });
  }
}
