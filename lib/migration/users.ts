/**
 * Turns legacy `profiles` + `auth.users` rows into the four things the new
 * platform needs for a working login: a Better Auth `user`, an
 * `accountprofiles` row, an entry in `companies.members[]`, and a company
 * `createdBy`. Pure — no database — so the rules are unit tested.
 *
 * Two decisions here are load-bearing:
 *
 * 1. **No password is migrated and no credential account is created.** Supabase
 *    stores bcrypt, Better Auth stores scrypt, and the hashes are not reachable
 *    through the API anyway. Better Auth's own reset-password route creates the
 *    credential account when one is missing
 *    (`node_modules/better-auth/dist/api/routes/password.mjs`), so a migrated
 *    user needs nothing but a `user` row: they request a reset, set a password,
 *    and the account row appears. Fabricating a hash would add risk for nothing.
 *
 * 2. **Every company gets an admin.** Legacy `profiles.role` is a free-text job
 *    title ("CEO", "Vertriebs-Assistenz", or blank) rather than a permission,
 *    and 28 of the 37 migrating companies have nobody marked `admin`. Without a
 *    fallback those tenants would migrate with no one able to manage them.
 */

export type MemberRole = "admin" | "member";

export interface SourceProfileRow {
  id: string;
  company_id: string | null;
  role?: string | null;
  user_role?: string | null;
  full_name?: string | null;
  is_onboarding_completed?: boolean | null;
  created_at?: string | null;
}

export interface SourceAuthUserRow {
  id: string;
  email: string | null;
  email_confirmed_at: string | null;
  created_at: string | null;
}

/**
 * Titles that imply the person runs the account. `user_role` is deliberately
 * ignored: it is "employee" for all 67 migrating profiles and carries no signal.
 */
const ADMIN_TITLES = new Set([
  "admin", "administrator", "owner", "ceo", "founder", "inhaber",
  "geschäftsführer", "geschaeftsfuehrer", "gf", "managing director",
]);

export function isAdminTitle(role: unknown): boolean {
  if (typeof role !== "string") return false;
  return ADMIN_TITLES.has(role.trim().toLowerCase());
}

/**
 * Staff and throwaway accounts that signed up against a real company's website.
 * The cohort filter vetted company names, not the people inside them, so a real
 * tenant can still have `admin@test.net` as its only profile.
 *
 * Used to keep such an account from being handed the admin role while a genuine
 * colleague is available — never to silently delete anyone.
 */
const TEST_EMAIL = /test|demo|dummy|fake|sample|example|\+test@/i;

/** Disposable-mailbox providers seen in the legacy data. */
const DISPOSABLE_DOMAINS = new Set([
  "amupx.com", "yzcalo.com", "olipii.com", "mailinator.com", "yopmail.com",
  "bltiwd.com", "bwmyga.com", "a7gi.ru", "ruutukf.com", "ozsaip.com",
]);

export function looksLikeTestEmail(email: unknown): boolean {
  if (typeof email !== "string") return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  const domain = normalized.split("@")[1] ?? "";
  return TEST_EMAIL.test(normalized) || DISPOSABLE_DOMAINS.has(domain);
}

export interface RoleAssignment {
  role: MemberRole;
  /** True when nobody held an admin title and this person was promoted. */
  promoted: boolean;
  /** True when the only candidate for admin looked like a test account. */
  promotedTestAccount?: boolean;
}

/**
 * Assigns one role per profile, guaranteeing at least one admin per company.
 *
 * When no title qualifies — 28 of the 37 migrating companies — the earliest
 * *genuine-looking* profile is promoted, because that is the account that signed
 * the company up. A test address is promoted only when it is the sole option,
 * and is flagged so the report can say so out loud.
 */
export function assignRoles(
  profiles: SourceProfileRow[],
  emailById: Map<string, string> = new Map(),
): Map<string, RoleAssignment> {
  const assignments = new Map<string, RoleAssignment>();
  if (profiles.length === 0) return assignments;

  const admins = profiles.filter((profile) => isAdminTitle(profile.role));

  if (admins.length > 0) {
    for (const profile of profiles) {
      assignments.set(profile.id, {
        role: isAdminTitle(profile.role) ? "admin" : "member",
        promoted: false,
      });
    }
    return assignments;
  }

  const isTest = (profile: SourceProfileRow) =>
    looksLikeTestEmail(emailById.get(profile.id));

  const [chosen] = [...profiles].sort((a, b) => {
    // A real colleague outranks a test address, whatever the dates say.
    const testGap = Number(isTest(a)) - Number(isTest(b));
    if (testGap !== 0) return testGap;
    const left = a.created_at ? Date.parse(a.created_at) : Number.POSITIVE_INFINITY;
    const right = b.created_at ? Date.parse(b.created_at) : Number.POSITIVE_INFINITY;
    return left - right || a.id.localeCompare(b.id);
  });

  for (const profile of profiles) {
    const isChosen = profile.id === chosen.id;
    assignments.set(profile.id, {
      role: isChosen ? "admin" : "member",
      promoted: isChosen,
      ...(isChosen && isTest(profile) ? { promotedTestAccount: true } : {}),
    });
  }

  return assignments;
}

export interface UserDocument {
  name: string;
  email: string;
  /** Better Auth types this as a boolean, not a date. */
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function buildUserDocument(input: {
  profile: SourceProfileRow;
  authUser: SourceAuthUserRow;
  now: Date;
}): UserDocument | null {
  const email = input.authUser.email?.trim().toLowerCase();
  if (!email) return null;

  const name =
    input.profile.full_name?.trim() ||
    // Better Auth marks name required; the local part is a better placeholder
    // than an empty string in the UI.
    email.split("@")[0];

  const createdAt = input.authUser.created_at
    ? new Date(input.authUser.created_at)
    : input.now;

  return {
    name,
    email,
    // Faithful to the source: six migrating users never confirmed their address,
    // and asserting otherwise would invent a security fact. Better Auth sends a
    // verification mail on their first sign-in attempt.
    emailVerified: Boolean(input.authUser.email_confirmed_at),
    createdAt,
    updatedAt: input.now,
  };
}

export interface AccountProfileDocument {
  /** Hex string of the user's ObjectId — NOT an ObjectId, unlike `account.userId`. */
  userId: string;
  email: string;
  role: MemberRole;
  membershipStatus: "active";
  onboardingCompleted: boolean;
  locale: "en" | "de";
  trialStartsAt: Date;
  trialEndsAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export function buildAccountProfile(input: {
  userId: string;
  email: string;
  role: MemberRole;
  locale: "en" | "de";
  trialStartsAt: Date;
  trialEndsAt: Date;
  now: Date;
}): AccountProfileDocument {
  return {
    userId: input.userId,
    email: input.email.toLowerCase(),
    role: input.role,
    // Everyone migrating already belongs to a company; a pending status would
    // bounce them off every page.
    membershipStatus: "active",
    // Must be true. `lib/company/context.ts` sends an incomplete profile back to
    // onboarding, where the user would create a second, duplicate company.
    onboardingCompleted: true,
    locale: input.locale,
    trialStartsAt: input.trialStartsAt,
    trialEndsAt: input.trialEndsAt,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export interface MemberEntry {
  /** Hex string, matching `companies.members[].userId` in the schema. */
  userId: string;
  email: string;
  role: MemberRole;
  joinedAt: Date;
}

export function buildMemberEntry(input: {
  userId: string;
  email: string;
  role: MemberRole;
  joinedAt: string | null | undefined;
  now: Date;
}): MemberEntry {
  return {
    userId: input.userId,
    email: input.email.toLowerCase(),
    role: input.role,
    joinedAt: input.joinedAt ? new Date(input.joinedAt) : input.now,
  };
}

/**
 * Picks the member whose id becomes the company's `createdBy`. Phase 3 wrote a
 * `legacy:<uuid>` placeholder because target user ids did not exist yet.
 */
export function pickCreatedBy(members: MemberEntry[]): string | null {
  if (members.length === 0) return null;
  const admins = members.filter((member) => member.role === "admin");
  const pool = admins.length > 0 ? admins : members;
  const [earliest] = [...pool].sort(
    (a, b) => a.joinedAt.getTime() - b.joinedAt.getTime(),
  );
  return earliest.userId;
}
