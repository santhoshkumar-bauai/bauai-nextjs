import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";

import { getCompanyContext } from "@/lib/company/context";
import { mongoDatabase } from "@/lib/db/mongodb";
import { connectMongoose } from "@/lib/db/mongoose";
import type { TenderDocument } from "@/lib/ingestion/types";
import { PIPELINE_STATUSES, TenderDecision } from "@/models/tender-decision";

/**
 * The company's kanban board plus its dead zone, with the member list the card
 * assignee picker needs. Permanently deleted tenders are omitted from both.
 */

const BOARD_CAP = 300;

export async function GET() {
  const context = await getCompanyContext();
  if (!context) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await connectMongoose();
  const decisions = await TenderDecision.find({
    companyId: String(context.company._id),
    status: { $in: [...PIPELINE_STATUSES, "deadzone"] },
  })
    .sort({ updatedAt: -1 })
    .limit(BOARD_CAP)
    .lean();

  const objectIds = decisions
    .filter((decision) => ObjectId.isValid(decision.tenderId))
    .map((decision) => new ObjectId(decision.tenderId));

  const tenders = objectIds.length
    ? await mongoDatabase
        .collection<TenderDocument>("tenders")
        .find(
          { _id: { $in: objectIds } },
          {
            projection: {
              _id: 1,
              title: 1,
              status: 1,
              submissionDeadline: 1,
              "buyer.name": 1,
              "buyer.address.city": 1,
            },
          },
        )
        .toArray()
    : [];

  const byId = new Map(tenders.map((tender) => [String(tender._id), tender]));

  const items = decisions.flatMap((decision) => {
    const tender = byId.get(decision.tenderId);
    // A tender purged from the corpus leaves a dangling decision; skip it
    // rather than rendering an empty card.
    if (!tender) return [];
    return [
      {
        tenderId: decision.tenderId,
        status: decision.status,
        assigneeUserId: decision.assigneeUserId ?? null,
        title: tender.title ?? null,
        buyerName: tender.buyer?.name ?? null,
        buyerCity: tender.buyer?.address?.city ?? null,
        tenderStatus: tender.status ?? null,
        submissionDeadline: tender.submissionDeadline
          ? new Date(tender.submissionDeadline).toISOString()
          : null,
        movedAt: decision.updatedAt ? new Date(decision.updatedAt).toISOString() : null,
      },
    ];
  });

  // Members have no stored display name — the app shows the email local part
  // wherever a person is named (same as the dashboard shell).
  const members = context.company.members.map((member) => ({
    userId: member.userId,
    email: member.email,
    name: member.email.split("@")[0],
    role: member.role,
  }));

  return NextResponse.json({
    items: items.filter((item) => item.status !== "deadzone"),
    deadzone: items.filter((item) => item.status === "deadzone"),
    members,
  });
}
