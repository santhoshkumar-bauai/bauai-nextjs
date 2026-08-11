import { isValidObjectId } from "mongoose";
import { NextResponse } from "next/server";

import { onlyOfficeEnabled } from "@/lib/onlyoffice/env";
import {
  processOnlyOfficeCallback,
  verifyOnlyOfficeCallback,
} from "@/lib/onlyoffice/callback";

type RouteContext = { params: Promise<{ documentId: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  if (!onlyOfficeEnabled()) {
    return NextResponse.json({ error: 1 }, { status: 503 });
  }
  const { documentId } = await params;
  if (!isValidObjectId(documentId)) return NextResponse.json({ error: 1 }, { status: 404 });
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 1 }, { status: 400 });
  }

  let callback;
  try {
    callback = await verifyOnlyOfficeCallback(request, body);
  } catch (error) {
    console.warn("Rejected ONLYOFFICE callback", error);
    return NextResponse.json({ error: 1 }, { status: 401 });
  }
  try {
    await processOnlyOfficeCallback(documentId, callback);
    return NextResponse.json({ error: 0 });
  } catch (error) {
    console.error("ONLYOFFICE callback persistence failed", error);
    return NextResponse.json({ error: 1 }, { status: 500 });
  }
}
