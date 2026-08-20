/**
 * Phase 9 of the Supabase → MongoDB migration: the passwords Phase 4 left out.
 *
 * Phase 4 wrote `user` rows with no `account`, on the reasoning that Better
 * Auth's reset-password route creates the credential account itself. That works,
 * but it costs every migrated user a reset mail before they can sign in. This
 * phase removes that cost by importing the bcrypt hashes GoTrue already held, so
 * the legacy password keeps working unchanged.
 *
 * Input is a CSV exported from the legacy project's SQL editor, using the query
 * `--emit-sql` prints. It is not read from Supabase directly because
 * `auth.users.encrypted_password` is not reachable over PostgREST (the project
 * exposes only `public` and `graphql_public`) nor over the GoTrue admin API,
 * and we hold no Postgres credential.
 *
 * Safety rules, all of them refusals rather than repairs:
 *   · only bcrypt hashes are imported — anything else is reported, not guessed
 *   · a user that already has a credential account is never touched, which is
 *     what makes this script safe to re-run
 *   · `emailVerified: false` users are skipped: Better Auth's
 *     revokeUnprovenAccountAccess() deletes the credential account of an
 *     unverified user the moment an email-primary proof lands, so importing one
 *     would quietly undo itself and leave a confusing audit trail
 *   · a CSV row with no matching Mongo user is reported, never inserted
 *
 * The CSV holds live password hashes. Delete it once this has run.
 *
 *   npm run migrate:passwords -- --emit-sql > export.sql
 *   npm run migrate:passwords -- --csv <path> [--dry-run] [--limit 5]
 *
 * `--emit-sql` derives the export query from whichever database MONGODB_URI
 * points at, so the exported cohort always matches the target. Deriving it once
 * and reusing it against a second database would silently export the wrong set
 * of users — the local and production rosters are not guaranteed to agree.
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { mkdir, readFile, writeFile } = await import("node:fs/promises");
const path = await import("node:path");
const { MongoClient, ObjectId } = await import("mongodb");

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const dryRun = has("dry-run");
const emitSql = has("emit-sql");
const limit = Number.parseInt(flag("limit") ?? "0", 10) || 0;
const csvPath = flag("csv");
if (!csvPath && !emitSql) {
  throw new Error(
    "--csv <path> is required (the hash export from the legacy SQL editor), " +
      "or --emit-sql to generate that export's query first.",
  );
}

const REPORT_DIR = path.join(process.cwd(), "docs", "migration-docs", "reports");

/** `$2$` is not a real prefix, but `$2a$`, `$2b$`, `$2x$` and `$2y$` all are. */
const BCRYPT_HASH = /^\$2[abxy]\$\d{2}\$/;

/**
 * RFC 4180 rather than `split(",")`: a bcrypt hash contains no comma, but the
 * timestamp columns are quoted and a malformed parse here would mean writing a
 * truncated hash, which fails as a silent lockout rather than an error.
 */
function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") field += char;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.length > 1 || entry[0] !== "");
}

/**
 * Emits the legacy-side export query, scoped to exactly the users this database
 * needs a hash for. Writing to stdout keeps the resulting file — and the hashes
 * it will hold — wherever the operator chooses to put it.
 */
async function emitExportSql(): Promise<string> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not configured.");
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const database = client.db(process.env.MONGODB_DB || "bauai");
    const withCredentials = await database
      .collection("account")
      .find({ providerId: "credential" }, { projection: { userId: 1 } })
      .toArray();
    const covered = new Set(withCredentials.map((account) => String(account.userId)));
    const all = await database
      .collection("user")
      .find({}, { projection: { email: 1, emailVerified: 1 } })
      .toArray();

    const missing = all.filter((user) => !covered.has(String(user._id)));
    const targets = missing
      .filter((user) => user.emailVerified === true)
      .map((user) => String(user.email).trim().toLowerCase())
      .sort();
    const unverified = missing.filter((user) => user.emailVerified !== true);

    console.error(
      `${all.length} users · ${covered.size} already have a credential account · ` +
        `${targets.length} need a hash · ${unverified.length} excluded as unverified`,
    );
    if (targets.length === 0) {
      throw new Error("no users need a hash — nothing to export.");
    }

    return [
      `-- Password hashes for the ${targets.length} users in ${database.databaseName} that have`,
      "-- no credential account. Run in the legacy Supabase project's SQL Editor,",
      '-- then "Download CSV". The editor runs as the postgres role, so no database',
      "-- password is needed.",
      "--",
      "-- Read-only, and scoped to exactly these addresses. Treat the CSV as a secret",
      "-- and delete it once the import has run.",
      "--",
      '-- Check "algo": every row should be $2a, $2b, $2x or $2y. Anything else is',
      "-- reported and skipped by the import rather than guessed at.",
      "",
      "select",
      "  lower(u.email)                as email,",
      "  u.encrypted_password          as password_hash,",
      "  left(u.encrypted_password, 4) as algo,",
      "  u.email_confirmed_at,",
      "  u.last_sign_in_at",
      "from auth.users u",
      "where u.deleted_at is null",
      "  and u.encrypted_password is not null",
      "  and lower(u.email) in (",
      targets.map((email) => `    '${email.replace(/'/g, "''")}'`).join(",\n"),
      "  )",
      "order by u.email;",
      "",
    ].join("\n");
  } finally {
    await client.close();
  }
}

if (emitSql) {
  process.stdout.write(await emitExportSql());
  process.exit(0);
}

// The `--emit-sql` branch exits above and the flag check at the top rejects a
// run with neither flag, so a CSV path is guaranteed from here on.
const csvFile = csvPath as string;

const rows = parseCsv(await readFile(csvFile, "utf8"));
const header = (rows[0] ?? []).map((column) => column.trim());
for (const required of ["email", "password_hash"]) {
  if (!header.includes(required)) {
    throw new Error(
      `${csvFile} has no "${required}" column (found: ${header.join(", ")}).`,
    );
  }
}

interface HashRow {
  email: string;
  hash: string;
}
const exported: HashRow[] = [];
const malformed: Array<{ email: string; reason: string }> = [];

for (const row of rows.slice(1)) {
  const record = Object.fromEntries(header.map((key, index) => [key, row[index] ?? ""]));
  const email = String(record.email ?? "").trim().toLowerCase();
  const hash = String(record.password_hash ?? "").trim();

  if (!email) continue;
  if (!hash) {
    malformed.push({ email, reason: "no password hash in the export" });
    continue;
  }
  if (!BCRYPT_HASH.test(hash)) {
    // argon2id or a firebase-scrypt blob: importable in principle, but only
    // with a verifier we have not written and cannot test against real input.
    malformed.push({
      email,
      reason: `unsupported hash algorithm (starts with ${JSON.stringify(hash.slice(0, 4))})`,
    });
    continue;
  }
  exported.push({ email, hash });
}

console.log(
  `read ${exported.length} bcrypt hashes from ${path.basename(csvFile)}` +
    `${malformed.length ? ` (${malformed.length} unusable)` : ""}` +
    `${dryRun ? " [dry run: nothing will be written]" : ""}`,
);

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("MONGODB_URI is not configured.");
const client = new MongoClient(uri);

const imported: string[] = [];
const skipped: Array<{ email: string; reason: string }> = [];

try {
  await client.connect();
  const database = client.db(process.env.MONGODB_DB || "bauai");
  const users = database.collection("user");
  const accounts = database.collection("account");

  for (const entry of exported.slice(0, limit || undefined)) {
    const user = await users.findOne<{
      _id: InstanceType<typeof ObjectId>;
      email: string;
      emailVerified?: boolean;
    }>({ email: entry.email });

    if (!user) {
      skipped.push({ email: entry.email, reason: "no user in the target" });
      continue;
    }
    if (user.emailVerified !== true) {
      skipped.push({
        email: entry.email,
        reason: "email not verified — a credential account here would be revoked",
      });
      continue;
    }

    const existing = await accounts.findOne({
      userId: user._id,
      providerId: "credential",
    });
    if (existing) {
      skipped.push({ email: entry.email, reason: "already has a credential account" });
      continue;
    }

    if (!dryRun) {
      const now = new Date();
      await accounts.insertOne({
        _id: new ObjectId(),
        // Better Auth stores `accountId` as a string and `userId` as the raw
        // ObjectId — matching what the running app writes, not a convention
        // invented here.
        accountId: user._id.toHexString(),
        providerId: "credential",
        userId: user._id,
        password: entry.hash,
        createdAt: now,
        updatedAt: now,
      });
    }
    imported.push(entry.email);
  }
} finally {
  await client.close();
}

for (const entry of malformed) {
  console.warn(`  UNUSABLE ${entry.email}: ${entry.reason}`);
}
for (const entry of skipped) {
  console.warn(`  SKIPPED  ${entry.email}: ${entry.reason}`);
}

console.log(
  `\nimported ${imported.length} credential accounts · ` +
    `skipped ${skipped.length} · unusable ${malformed.length}`,
);

const report = {
  phase: "09-passwords",
  ranAt: new Date().toISOString(),
  dryRun,
  source: path.basename(csvFile),
  totals: {
    exportedRows: exported.length + malformed.length,
    bcryptHashes: exported.length,
    imported: imported.length,
    skipped: skipped.length,
    unusable: malformed.length,
  },
  imported,
  skipped,
  malformed,
  note:
    "Imported hashes are bcrypt; lib/auth-password.ts verifies them alongside " +
    "Better Auth scrypt. New passwords are always scrypt, so this population " +
    "only shrinks. No hash is recorded in this report.",
};

if (dryRun) {
  console.log("\n[dry run] nothing was written");
} else {
  await mkdir(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "phase-09-passwords.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`wrote ${reportPath}`);
  console.log("\nNext: delete the CSV — it holds live password hashes.");
}
