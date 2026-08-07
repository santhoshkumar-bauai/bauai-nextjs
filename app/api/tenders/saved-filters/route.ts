import type { WithId } from "mongodb";
import { NextResponse } from "next/server";

import { getCompanyContext } from "@/lib/company/context";
import { mongoDatabase } from "@/lib/db/mongodb";
import {
  normalizeTenderFilters,
  type TenderFilters,
} from "@/lib/tenders/filters";

/**
 * Per-user saved filter presets. Stored in `saved_tender_filters`, scoped by the
 * authenticated user id from `getCompanyContext()`.
 */

interface SavedFilterDoc {
  userId: string;
  name: string;
  filters: TenderFilters;
  createdAt: Date;
}

const MAX_PRESETS = 20;

function collection() {
  return mongoDatabase.collection<SavedFilterDoc>("saved_tender_filters");
}

function serialize(doc: WithId<SavedFilterDoc>) {
  return {
    id: String(doc._id),
    name: doc.name,
    filters: doc.filters,
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
  };
}

export async function GET() {
  const context = await getCompanyContext();
  if (!context) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const docs = await collection()
    .find({ userId: context.userId })
    .sort({ createdAt: -1 })
    .limit(MAX_PRESETS)
    .toArray();

  return NextResponse.json({ items: docs.map(serialize) });
}

export async function POST(request: Request) {
  const context = await getCompanyContext();
  if (!context) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
    filters?: unknown;
  } | null;

  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 60) : "";
  if (!name) {
    return NextResponse.json({ error: "A preset name is required." }, { status: 400 });
  }

  const count = await collection().countDocuments({ userId: context.userId });
  if (count >= MAX_PRESETS) {
    return NextResponse.json(
      { error: `You can save up to ${MAX_PRESETS} filter presets.` },
      { status: 409 },
    );
  }

  const doc: SavedFilterDoc = {
    userId: context.userId,
    name,
    filters: normalizeTenderFilters(body?.filters),
    createdAt: new Date(),
  };
  const result = await collection().insertOne(doc);

  return NextResponse.json({
    savedFilter: serialize({ ...doc, _id: result.insertedId }),
  });
}
