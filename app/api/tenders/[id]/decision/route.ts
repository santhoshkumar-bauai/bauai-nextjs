import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";

import { getCompanyContext } from "@/lib/company/context";
import { connectMongoose } from "@/lib/db/mongoose";
import {
  DECISION_STATUSES,
  TenderDecision,
  type DecisionStatus,
} from "@/models/tender-decision";

/**
 * Per-tender pipeline decision for the authenticated company: "To Workspace"
 * (a kanban column, default `interested`) or "Reject". Idempotent upsert keyed
 * by (company, tender), so re-deciding moves the tender rather than duplicating
 * it. DELETE is the undo path used by the card's countdown.
 */

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: RouteContext) {
  const companyContext = await getCompanyContext();
  if (!companyContext) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await context.params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Unknown tender." }, { status: 404 });
  }

  let body: { status?: unknown; assigneeUserId?: unknown };
  try {
    body = (await request.json()) as {
      status?: unknown;
      assigneeUserId?: unknown;
    };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const status = body.status;
  if (
    typeof status !== "string" ||
    !(DECISION_STATUSES as readonly string[]).includes(status)
  ) {
    return NextResponse.json(
      { error: `status must be one of: ${DECISION_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }

  // An assignee must be a member of this company — never an arbitrary user id.
  // Three distinct cases: absent (leave as-is), null (clear), id (set).
  const assigneeGiven = "assigneeUserId" in body && body.assigneeUserId !== undefined;
  let assigneeUserId: string | null = null;
  if (assigneeGiven) {
    if (body.assigneeUserId !== null && typeof body.assigneeUserId !== "string") {
      return NextResponse.json(
        { error: "assigneeUserId must be a string or null." },
        { status: 400 },
      );
    }
    if (typeof body.assigneeUserId === "string") {
      const isMember = companyContext.company.members.some(
        (member) => member.userId === body.assigneeUserId,
      );
      if (!isMember) {
        return NextResponse.json(
          { error: "Assignee is not a member of this company." },
          { status: 400 },
        );
      }
      assigneeUserId = body.assigneeUserId;
    }
  }

  await connectMongoose();
  const companyId = String(companyContext.company._id);
  const set: Record<string, unknown> = {
    status: status as DecisionStatus,
    decidedByUserId: companyContext.userId,
  };

  // A single field may appear in only one update operator, so these three
  // branches are mutually exclusive by construction.
  const update: Record<string, unknown> = { $set: set };
  if (assigneeGiven && assigneeUserId !== null) {
    set.assigneeUserId = assigneeUserId;
  } else if (assigneeGiven) {
    update.$unset = { assigneeUserId: "" };
  } else {
    // A tender entering the pipeline unassigned falls to whoever moved it.
    update.$setOnInsert = { assigneeUserId: companyContext.userId };
  }

  const decision = await TenderDecision.findOneAndUpdate(
    // companyId/tenderId come from the equality filter on upsert, so they must
    // not also appear in an update operator.
    { companyId, tenderId: id },
    update,
    { upsert: true, new: true },
  ).lean();

  return NextResponse.json({
    decision: {
      tenderId: id,
      status: decision?.status ?? status,
      assigneeUserId: decision?.assigneeUserId ?? null,
    },
  });
}

export async function DELETE(_request: Request, context: RouteContext) {
  const companyContext = await getCompanyContext();
  if (!companyContext) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await context.params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Unknown tender." }, { status: 404 });
  }

  await connectMongoose();
  await TenderDecision.deleteOne({
    companyId: String(companyContext.company._id),
    tenderId: id,
  });

  return NextResponse.json({ decision: null });
}
