import { NextResponse } from "next/server";

import { corsHeadersFor, handlePreflight } from "@/lib/dora-gateway/cors";

/** Unauthenticated liveness probe for the editor panel's boot self-check. */

export function OPTIONS(request: Request) {
  return handlePreflight(request);
}

export function GET(request: Request) {
  return NextResponse.json(
    { ok: true, service: "dora-gateway" },
    { headers: corsHeadersFor(request) ?? undefined },
  );
}
