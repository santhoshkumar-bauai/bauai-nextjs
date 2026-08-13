/**
 * Read-only access to the legacy Supabase (mvp1-bauai) database.
 *
 * Every migration phase reads from here and writes to Mongo; nothing in this
 * module ever writes back. The service-role key bypasses RLS by design — the
 * legacy schema left 29 tables without policies, so a scoped key could not read
 * the data we need to migrate.
 *
 * The key lives in env, never in code. It is the same key flagged for rotation
 * in the migration proposal (§2.3); rotate it first, then put the new value in
 * `.env.local` as MIGRATION_SUPABASE_SERVICE_ROLE_KEY.
 */

export interface SourceEnv {
  url: string;
  serviceRoleKey: string;
}

let cached: SourceEnv | null = null;

/**
 * Lazy + cached so that merely importing this module never throws — matching
 * `lib/ai/config/env.ts`, which is lazy so a Next.js build cannot crash on a
 * missing secret it never uses.
 */
export function sourceEnv(): SourceEnv {
  if (cached) return cached;

  const url = process.env.MIGRATION_SUPABASE_URL;
  const serviceRoleKey = process.env.MIGRATION_SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error(
      "MIGRATION_SUPABASE_URL is not set. Add the legacy Supabase project URL to .env.local.",
    );
  }
  if (!serviceRoleKey) {
    throw new Error(
      "MIGRATION_SUPABASE_SERVICE_ROLE_KEY is not set. Add the (rotated) service-role key to .env.local.",
    );
  }

  cached = { url: url.replace(/\/+$/, ""), serviceRoleKey };
  return cached;
}

function headers(): Record<string, string> {
  const { serviceRoleKey } = sourceEnv();
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };
}

/** PostgREST caps a response at 1000 rows regardless of `limit`. */
const PAGE_SIZE = 1000;

/**
 * Fetches every row of a PostgREST query, paging through the Range header.
 *
 * `pathWithQuery` is everything after `/rest/v1/`, e.g.
 * `companies?select=id,name` — filters and ordering are the caller's business.
 */
export async function fetchAll<T>(pathWithQuery: string): Promise<T[]> {
  const { url } = sourceEnv();
  const rows: T[] = [];

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const response = await fetch(`${url}/rest/v1/${pathWithQuery}`, {
      headers: { ...headers(), Range: `${offset}-${offset + PAGE_SIZE - 1}` },
    });

    if (!response.ok) {
      throw new Error(
        `Supabase read failed (${response.status}) for ${pathWithQuery}: ${await response.text()}`,
      );
    }

    const batch = (await response.json()) as T[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }

  return rows;
}

/** Exact row count via the Content-Range header, without transferring rows. */
export async function fetchCount(pathWithQuery: string): Promise<number> {
  const { url } = sourceEnv();
  const response = await fetch(`${url}/rest/v1/${pathWithQuery}`, {
    headers: { ...headers(), Prefer: "count=exact", Range: "0-0" },
  });

  const contentRange = response.headers.get("content-range") ?? "";
  const total = Number.parseInt(contentRange.split("/").pop() ?? "", 10);
  return Number.isFinite(total) ? total : 0;
}

/**
 * A GoTrue admin user. Note `identities` is documented but comes back empty
 * from the admin list endpoint on this project, so provider split cannot be
 * derived here — it needs a direct `auth.identities` read.
 */
export interface SourceAuthUser {
  id: string;
  email: string | null;
  email_confirmed_at: string | null;
  last_sign_in_at: string | null;
  created_at: string | null;
  identities?: Array<{ provider: string }> | null;
}

/** Pages the GoTrue admin API, which is separate from PostgREST. */
export async function fetchAuthUsers(): Promise<SourceAuthUser[]> {
  const { url } = sourceEnv();
  const users: SourceAuthUser[] = [];

  for (let page = 1; ; page += 1) {
    const response = await fetch(
      `${url}/auth/v1/admin/users?page=${page}&per_page=200`,
      { headers: headers() },
    );

    if (!response.ok) {
      throw new Error(
        `Supabase auth read failed (${response.status}): ${await response.text()}`,
      );
    }

    const body = (await response.json()) as { users?: SourceAuthUser[] };
    const batch = body.users ?? [];
    if (batch.length === 0) break;
    users.push(...batch);
    if (batch.length < 200) break;
  }

  return users;
}
