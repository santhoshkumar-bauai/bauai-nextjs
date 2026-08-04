import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { connectMongoose } from "@/lib/db/mongoose";
import { AccountProfile } from "@/models/account-profile";
import { Company } from "@/models/company";

type ReviewBody = {
  userId?: unknown;
  action?: unknown;
};

async function getAdminContext() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.emailVerified) return null;

  await connectMongoose();
  const profile = await AccountProfile.findOne({
    userId: session.user.id,
    role: "admin",
    $or: [
      { membershipStatus: "active" },
      { membershipStatus: { $exists: false } },
    ],
  }).lean();
  if (!profile) return null;

  const company = await Company.findOne({
    _id: profile.companyId,
    members: { $elemMatch: { userId: session.user.id, role: "admin" } },
  });
  if (!company) return null;
  return { session, profile, company };
}

export async function GET() {
  const context = await getAdminContext();
  if (!context)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  return NextResponse.json({
    items: context.company.membershipRequests
      .filter((request) => request.status === "pending")
      .map((request) => ({
        userId: request.userId,
        email: request.email,
        requestedAt: request.requestedAt,
      })),
  });
}

export async function PATCH(request: Request) {
  const context = await getAdminContext();
  if (!context)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await request.json()) as ReviewBody;
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  const action =
    body.action === "approve" || body.action === "reject" ? body.action : null;
  if (!userId || !action || userId === context.session.user.id) {
    return NextResponse.json(
      { error: "Invalid membership review." },
      { status: 400 },
    );
  }

  const pendingRequest = context.company.membershipRequests.find(
    (item) => item.userId === userId && item.status === "pending",
  );
  if (!pendingRequest) {
    return NextResponse.json(
      { error: "Pending request not found." },
      { status: 404 },
    );
  }

  const targetProfile = await AccountProfile.findOne({
    userId,
    companyId: context.company._id,
    membershipStatus: "pending",
  }).lean();
  if (!targetProfile) {
    return NextResponse.json(
      { error: "Pending user profile not found." },
      { status: 404 },
    );
  }

  const now = new Date();
  const status = action === "approve" ? "approved" : "rejected";
  const reviewResult = await Company.updateOne(
    { _id: context.company._id },
    {
      $set: {
        "membershipRequests.$[membershipRequest].status": status,
        "membershipRequests.$[membershipRequest].reviewedAt": now,
        "membershipRequests.$[membershipRequest].reviewedBy":
          context.session.user.id,
      },
    },
    {
      arrayFilters: [
        {
          "membershipRequest.userId": userId,
          "membershipRequest.status": "pending",
        },
      ],
    },
  );
  if (reviewResult.modifiedCount !== 1) {
    return NextResponse.json(
      { error: "This request has already been reviewed." },
      { status: 409 },
    );
  }

  if (action === "approve") {
    await Company.updateOne(
      { _id: context.company._id, "members.userId": { $ne: userId } },
      {
        $push: {
          members: {
            userId,
            email: pendingRequest.email,
            role: "member",
            joinedAt: now,
          },
        },
      },
    );
  }

  await AccountProfile.updateOne(
    { userId, companyId: context.company._id, membershipStatus: "pending" },
    {
      $set: {
        membershipStatus: action === "approve" ? "active" : "rejected",
        role: "member",
      },
    },
  );

  return NextResponse.json({ ok: true, status });
}
