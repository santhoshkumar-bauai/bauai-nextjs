import { describe, expect, it } from "vitest";

import {
  type MemberEntry,
  type SourceProfileRow,
  assignRoles,
  buildAccountProfile,
  buildMemberEntry,
  buildUserDocument,
  isAdminTitle,
  looksLikeTestEmail,
  pickCreatedBy,
} from "./users.ts";

const NOW = new Date("2026-08-12T12:00:00.000Z");
const TRIAL_END = new Date("2026-09-11T12:00:00.000Z");

function profile(
  id: string,
  overrides: Partial<SourceProfileRow> = {},
): SourceProfileRow {
  return { id, company_id: "c1", created_at: "2026-01-01T00:00:00Z", ...overrides };
}

describe("isAdminTitle", () => {
  it("recognises the titles that mean 'runs the account'", () => {
    expect(isAdminTitle("admin")).toBe(true);
    expect(isAdminTitle("CEO")).toBe(true);
    expect(isAdminTitle(" Geschäftsführer ")).toBe(true);
  });

  it("treats other free-text job titles as members", () => {
    // Real values from the legacy profiles table.
    expect(isAdminTitle("Vertriebs-Assistenz")).toBe(false);
    expect(isAdminTitle("Employee")).toBe(false);
    expect(isAdminTitle("")).toBe(false);
    expect(isAdminTitle(null)).toBe(false);
  });
});

describe("assignRoles", () => {
  it("honours explicit admin titles and makes everyone else a member", () => {
    const roles = assignRoles([
      profile("a", { role: "admin" }),
      profile("b", { role: "Employee" }),
      profile("c", { role: "CEO" }),
    ]);

    expect(roles.get("a")).toEqual({ role: "admin", promoted: false });
    expect(roles.get("b")).toEqual({ role: "member", promoted: false });
    expect(roles.get("c")).toEqual({ role: "admin", promoted: false });
  });

  it("promotes the earliest profile when nobody holds an admin title", () => {
    // 28 of the 37 migrating companies land here; without this they would have
    // no one able to manage the tenant.
    const roles = assignRoles([
      profile("late", { role: "", created_at: "2026-05-01T00:00:00Z" }),
      profile("first", { role: "Vertriebs-Assistenz", created_at: "2026-02-01T00:00:00Z" }),
    ]);

    expect(roles.get("first")).toEqual({ role: "admin", promoted: true });
    expect(roles.get("late")).toEqual({ role: "member", promoted: false });
  });

  it("still picks a deterministic admin when creation dates are missing", () => {
    const roles = assignRoles([
      profile("b", { role: "", created_at: null }),
      profile("a", { role: "", created_at: null }),
    ]);

    expect(roles.get("a")?.role).toBe("admin");
    expect(roles.get("b")?.role).toBe("member");
  });

  it("returns nothing for a company with no profiles", () => {
    expect(assignRoles([]).size).toBe(0);
  });

  it("never hands a real company to a test account when a colleague exists", () => {
    // Production: real firms have staff/test signups sitting alongside real
    // people, and the test account is often the oldest profile.
    const emails = new Map([
      ["tester", "admin@test.net"],
      ["real", "t.festerling@hansabauteam.de"],
    ]);
    const roles = assignRoles(
      [
        profile("tester", { role: "", created_at: "2026-01-01T00:00:00Z" }),
        profile("real", { role: "", created_at: "2026-06-01T00:00:00Z" }),
      ],
      emails,
    );

    expect(roles.get("real")?.role).toBe("admin");
    expect(roles.get("tester")?.role).toBe("member");
  });

  it("flags the case where the only possible admin is a test account", () => {
    const emails = new Map([["only", "baufirm@baufirmatest.de"]]);
    const roles = assignRoles([profile("only", { role: "" })], emails);

    expect(roles.get("only")).toEqual({
      role: "admin",
      promoted: true,
      promotedTestAccount: true,
    });
  });

  it("always yields at least one admin", () => {
    for (const roleValue of ["", "Employee", "admin", null]) {
      const roles = assignRoles([
        profile("a", { role: roleValue }),
        profile("b", { role: "" }),
      ]);
      const admins = [...roles.values()].filter((item) => item.role === "admin");
      expect(admins.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("looksLikeTestEmail", () => {
  it("spots the staff and throwaway addresses inside real companies", () => {
    expect(looksLikeTestEmail("admin@test.net")).toBe(true);
    expect(looksLikeTestEmail("baufirm@baufirmatest.de")).toBe(true);
    // Disposable mailbox seen against a real construction firm.
    expect(looksLikeTestEmail("nehic50244@amupx.com")).toBe(true);
  });

  it("leaves genuine company addresses alone", () => {
    expect(looksLikeTestEmail("t.festerling@hansabauteam.de")).toBe(false);
    expect(looksLikeTestEmail("paul.schenk@brueninghoff.de")).toBe(false);
    expect(looksLikeTestEmail("f.giebler@schrobsdorff.ag")).toBe(false);
    expect(looksLikeTestEmail(null)).toBe(false);
  });
});

describe("buildUserDocument", () => {
  const authUser = {
    id: "u1",
    email: " Owner@Example.DE ",
    email_confirmed_at: "2026-03-01T00:00:00Z",
    created_at: "2026-02-01T00:00:00Z",
  };

  it("lowercases the email and keeps emailVerified a boolean", () => {
    const document = buildUserDocument({
      profile: profile("u1", { full_name: "Anna Bauer" }),
      authUser,
      now: NOW,
    })!;

    expect(document.email).toBe("owner@example.de");
    expect(document.name).toBe("Anna Bauer");
    // Better Auth types this as boolean; a date here breaks sign-in.
    expect(document.emailVerified).toBe(true);
    expect(typeof document.emailVerified).toBe("boolean");
    expect(document.createdAt).toEqual(new Date("2026-02-01T00:00:00Z"));
  });

  it("stays faithful to an unconfirmed address rather than inventing trust", () => {
    const document = buildUserDocument({
      profile: profile("u1"),
      authUser: { ...authUser, email_confirmed_at: null },
      now: NOW,
    })!;

    expect(document.emailVerified).toBe(false);
  });

  it("falls back to the email local part when there is no name", () => {
    const document = buildUserDocument({
      profile: profile("u1", { full_name: "   " }),
      authUser,
      now: NOW,
    })!;

    expect(document.name).toBe("owner");
  });

  it("refuses a user with no email — there would be no way to sign in", () => {
    expect(
      buildUserDocument({
        profile: profile("u1"),
        authUser: { ...authUser, email: null },
        now: NOW,
      }),
    ).toBeNull();
  });
});

describe("buildAccountProfile", () => {
  it("marks onboarding complete so migrated users are not sent to re-onboard", () => {
    const document = buildAccountProfile({
      userId: "68b1f0c2a9e4d31f7c0a1b23",
      email: "Owner@Example.DE",
      role: "admin",
      locale: "de",
      trialStartsAt: NOW,
      trialEndsAt: TRIAL_END,
      now: NOW,
    });

    // A false here sends the user into onboarding, where they would create a
    // second company alongside the one just migrated.
    expect(document.onboardingCompleted).toBe(true);
    expect(document.membershipStatus).toBe("active");
    expect(document.email).toBe("owner@example.de");
    // Hex string, not an ObjectId — the opposite of account.userId.
    expect(typeof document.userId).toBe("string");
  });
});

describe("pickCreatedBy", () => {
  function member(
    userId: string,
    role: "admin" | "member",
    joinedAt: string,
  ): MemberEntry {
    return buildMemberEntry({
      userId,
      email: `${userId}@example.de`,
      role,
      joinedAt,
      now: NOW,
    });
  }

  it("prefers the earliest admin", () => {
    expect(
      pickCreatedBy([
        member("late-admin", "admin", "2026-05-01T00:00:00Z"),
        member("early-admin", "admin", "2026-01-01T00:00:00Z"),
        member("member", "member", "2025-01-01T00:00:00Z"),
      ]),
    ).toBe("early-admin");
  });

  it("falls back to the earliest member when there is no admin", () => {
    expect(
      pickCreatedBy([
        member("b", "member", "2026-05-01T00:00:00Z"),
        member("a", "member", "2026-01-01T00:00:00Z"),
      ]),
    ).toBe("a");
  });

  it("returns null for an empty company", () => {
    expect(pickCreatedBy([])).toBeNull();
  });
});
