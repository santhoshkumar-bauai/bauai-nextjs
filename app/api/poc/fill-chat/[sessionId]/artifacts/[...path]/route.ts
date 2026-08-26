import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";

import {
  getSandboxClient,
  SandboxRequestError,
  SandboxUnavailableError,
} from "@/lib/ai/fill-agent/sandbox-client";
import { getFillSession } from "@/lib/ai/fill-agent/store";
import { forCompanyContext } from "@/lib/ai/tenant/repository";
import { getCompanyContext } from "@/lib/company/context";

/**
 * Sandbox artifact proxy for the preview panel: page renders and crops only,
 * via a strict allowlist (the sidecar enforces its own path jail; this is the
 * second, narrower gate — the browser can reach exactly the render surface,
 * nothing else in the workspace).
 */

const ALLOWED = /^(source_pages|output_pages|crops)\/[A-Za-z0-9._-]+\.png$/;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string; path: string[] }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { sessionId, path } = await params;
  const relPath = path.join("/");
  if (!ALLOWED.test(relPath)) {
    return NextResponse.json({ error: "not_allowed" }, { status: 400 });
  }
  if (!ObjectId.isValid(sessionId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const tenantId = forCompanyContext(context).value;
  const session = await getFillSession(tenantId, new ObjectId(sessionId));
  if (!session?.sandboxSessionId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const bytes = await getSandboxClient().downloadFile(
      session.sandboxSessionId,
      relPath,
    );
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": "image/png",
        "cache-control": "private, max-age=30",
      },
    });
  } catch (error) {
    if (error instanceof SandboxRequestError && error.status === 404) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (error instanceof SandboxUnavailableError) {
      return NextResponse.json({ error: "sandbox_unavailable" }, { status: 503 });
    }
    throw error;
  }
}
