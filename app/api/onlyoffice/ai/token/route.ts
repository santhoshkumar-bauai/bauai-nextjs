import { NextResponse } from "next/server";

import { onlyOfficeAiEnabled } from "@/lib/onlyoffice/env";
import { authorizePluginScope, pluginCorsHeaders } from "@/lib/onlyoffice/plugin-auth";
import { signAiAccessToken, verifyEditorGrant } from "@/lib/onlyoffice/tokens";

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
  const body = (await request.json().catch(() => null)) as { editorGrant?: unknown } | null;
  if (typeof body?.editorGrant !== "string") {
    return NextResponse.json({ error: "invalid_grant" }, { status: 401, headers });
  }
  try {
    const grant = await verifyEditorGrant(body.editorGrant);
    const document = await authorizePluginScope(grant);
    if (!document) return NextResponse.json({ error: "invalid_grant" }, { status: 401, headers });
    const accessToken = await signAiAccessToken(grant);
    return NextResponse.json({ accessToken, expiresIn: 15 * 60 }, { headers });
  } catch {
    return NextResponse.json({ error: "invalid_grant" }, { status: 401, headers });
  }
}
