/**
 * Phase 6 of the Supabase → MongoDB migration: the customers' own files.
 *
 * Copies each company's documents out of Supabase Storage into our S3 bucket and
 * records them as `companyfiles`, using the same key layout and helpers the
 * upload route uses, so a migrated file is indistinguishable from one a user
 * uploads today.
 *
 * WHAT IS AND IS NOT COPIED (see lib/migration/documents.ts):
 *   company documents  — profile uploads in GAigentFiles. Copied.
 *   chat attachments   — files dropped into a conversation. In this data they
 *                        are overwhelmingly other people's tender paperwork
 *                        ("Vergabeunterlagen.pdf"), and the company knowledge
 *                        base is what profile auto-fill and Clara's company
 *                        search read. Skipped unless --include-chat-attachments.
 *   tender artifacts   — eForms XML. Never copied; the corpus has these already.
 *
 * Logos are handled separately: the app stores them as `companies.logoKey`, not
 * as a `companyfiles` row.
 *
 * After a real run, embed the new files:  npm run ai:embed:company
 *
 *   npm run migrate:documents -- [--dry-run] [--limit 10]
 *                                [--include-chat-attachments] [--concurrency 4]
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { mkdir, readFile, writeFile } = await import("node:fs/promises");
const path = await import("node:path");
const { randomUUID } = await import("node:crypto");
const { MongoClient } = await import("mongodb");
// Only ever read off a document, never constructed here.
type ObjectId = import("mongodb").ObjectId;
const { fetchAll, sourceEnv } = await import("../lib/migration/source.ts");
const { classifyDocument, dedupePlannedFiles, parseStoragePath, planFile } =
  await import("../lib/migration/documents.ts");
const { buildObjectKey, putObjectBuffer, s3Config, assertS3Configured } =
  await import("../lib/storage/s3.ts");

type LegacyDocumentRow = import("../lib/migration/documents.ts").LegacyDocumentRow;
type PlannedFile = import("../lib/migration/documents.ts").PlannedFile;
type CohortReport = import("../lib/migration/cohort.ts").CohortReport;

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const dryRun = has("dry-run");
const includeChatAttachments = has("include-chat-attachments");
const limit = Number.parseInt(flag("limit") ?? "0", 10) || 0;
const concurrency = Math.max(1, Number.parseInt(flag("concurrency") ?? "4", 10) || 4);

const REPORT_DIR = path.join(process.cwd(), "docs", "migration-docs", "reports");

const cohort = JSON.parse(
  await readFile(path.join(REPORT_DIR, "cohort.json"), "utf8"),
) as CohortReport;
if (!cohort.signedOffBy) {
  throw new Error("cohort is not signed off — see docs/migration-docs/cohort-overrides.json");
}

interface PhaseThreeReport {
  companies: Array<{ domain: string; legacyIds: string[] }>;
}
const phaseThree = JSON.parse(
  await readFile(path.join(REPORT_DIR, "phase-03-companies.json"), "utf8"),
) as PhaseThreeReport;

const domainByLegacyCompany = new Map<string, string>();
for (const company of phaseThree.companies) {
  for (const legacyId of company.legacyIds) {
    domainByLegacyCompany.set(legacyId, company.domain);
  }
}
const legacyCompanyIds = [...domainByLegacyCompany.keys()];

// Fail before any transfer if the destination is not configured. Bound to an
// explicitly typed const because TypeScript refuses to treat an assertion
// function reached through a destructured dynamic import as one.
const ensureS3Configured: () => void = assertS3Configured;
if (!dryRun) ensureS3Configured();

console.log(
  `collecting files for ${phaseThree.companies.length} companies` +
    `${dryRun ? " [dry run: nothing downloaded or uploaded]" : ""}`,
);

const documentRows = await fetchAll<LegacyDocumentRow>(
  `extracted_document?select=id,company_id,file_name,mime_type,file_size,storage_path` +
    `&company_id=in.(${legacyCompanyIds.join(",")})&storage_path=not.is.null`,
);

const kinds = { "company-document": 0, "chat-attachment": 0, "tender-artifact": 0 };
for (const row of documentRows) kinds[classifyDocument(row)] += 1;
console.log(
  `  ${documentRows.length} rows → company documents ${kinds["company-document"]}, ` +
    `chat attachments ${kinds["chat-attachment"]}, tender artifacts ${kinds["tender-artifact"]}`,
);

const wanted = documentRows.filter((row) => {
  const kind = classifyDocument(row);
  if (kind === "tender-artifact") return false;
  return kind === "company-document" || includeChatAttachments;
});

const planned = dedupePlannedFiles(
  wanted.flatMap((row) => {
    const file = planFile(row);
    return file ? [file] : [];
  }),
);

const totalBytes = planned.reduce((sum, file) => sum + file.size, 0);
console.log(
  `  ${planned.length} files to copy (${(totalBytes / 1048576).toFixed(1)} MB)` +
    `${includeChatAttachments ? " including chat attachments" : ""}`,
);

// Company logos live on the company document, not in `companyfiles`.
const companyRows = await fetchAll<{ id: string; logo_url: string | null }>(
  `companies?select=id,logo_url&id=in.(${legacyCompanyIds.join(",")})&logo_url=not.is.null`,
);
console.log(`  ${companyRows.length} logos`);

const { url: supabaseUrl, serviceRoleKey } = sourceEnv();
const storageHeaders = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
};

async function downloadObject(bucket: string, objectPath: string): Promise<Buffer> {
  const encoded = objectPath.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encoded}`,
    { headers: storageHeaders, signal: AbortSignal.timeout(120_000) },
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${bucket}/${objectPath}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("MONGODB_URI is not configured.");
const client = new MongoClient(uri);

interface Failure {
  fileName: string;
  reason: string;
}

const copied: string[] = [];
const skippedExisting: string[] = [];
const failures: Failure[] = [];
const logosCopied: string[] = [];

try {
  await client.connect();
  const database = client.db(process.env.MONGODB_DB || "bauai");
  const companies = database.collection("companies");
  const companyFiles = database.collection("companyfiles");

  if (!dryRun) {
    // Declared by the model; a standalone run must not leave it missing.
    await companyFiles.createIndex({ s3Key: 1 }, { unique: true });
    await companyFiles.createIndex({ companyId: 1, category: 1, createdAt: -1 });
  }

  // Resolve each company once.
  const targetByLegacyId = new Map<
    string,
    { id: ObjectId; domain: string; adminUserId: string }
  >();
  for (const [legacyId, domain] of domainByLegacyCompany) {
    const company = await companies.findOne<{
      _id: ObjectId;
      members?: Array<{ userId: string; role: string }>;
    }>({ domain }, { projection: { members: 1 } });
    if (!company) continue;
    const members = company.members ?? [];
    const admin = members.find((member) => member.role === "admin") ?? members[0];
    if (!admin) continue;
    targetByLegacyId.set(legacyId, {
      id: company._id,
      domain,
      adminUserId: admin.userId,
    });
  }

  const targets = limit ? planned.slice(0, limit) : planned;

  async function migrateOne(file: PlannedFile): Promise<void> {
    const target = targetByLegacyId.get(file.legacyCompanyId);
    if (!target) {
      failures.push({ fileName: file.fileName, reason: "company not migrated" });
      return;
    }

    // Idempotency: the same object copied again would otherwise land under a
    // fresh uuid key and duplicate the file.
    const existing = await companyFiles.findOne(
      {
        companyId: target.id,
        fileName: file.fileName,
        "migration.objectPath": file.ref.objectPath,
      },
      { projection: { _id: 1 } },
    );
    if (existing) {
      skippedExisting.push(file.fileName);
      return;
    }

    if (dryRun) {
      copied.push(file.fileName);
      return;
    }

    try {
      const body = await downloadObject(file.ref.bucket, file.ref.objectPath);
      const key = buildObjectKey({
        companyId: target.id.toHexString(),
        category: file.category,
        fileName: file.fileName,
        uniqueId: randomUUID(),
      });
      await putObjectBuffer(key, body, file.contentType);

      const now = new Date();
      await companyFiles.insertOne({
        companyId: target.id,
        category: file.category,
        fileName: file.fileName,
        contentType: file.contentType,
        size: body.byteLength,
        s3Bucket: s3Config().bucket,
        s3Key: key,
        uploadedBy: target.adminUserId,
        createdAt: now,
        updatedAt: now,
        __v: 0,
        // Provenance, and the idempotency key for re-runs.
        migration: {
          legacyId: file.legacyId,
          bucket: file.ref.bucket,
          objectPath: file.ref.objectPath,
          kind: file.kind,
          ranAt: now,
        },
      });
      copied.push(file.fileName);
    } catch (error) {
      failures.push({
        fileName: file.fileName,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Bounded concurrency: a few hundred megabytes, politely.
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
      while (cursor < targets.length) {
        const index = cursor++;
        await migrateOne(targets[index]);
        const done = copied.length + skippedExisting.length + failures.length;
        if (done % 25 === 0) {
          console.log(
            `  ${done}/${targets.length} (copied ${copied.length}, skipped ${skippedExisting.length}, failed ${failures.length})`,
          );
        }
      }
    }),
  );

  // Logos: stored as companies.logoKey, never as a companyfiles row.
  for (const row of companyRows) {
    const target = targetByLegacyId.get(row.id);
    const ref = parseStoragePath(row.logo_url);
    if (!target || !ref) {
      // Reported rather than dropped: a logo that cannot be placed is a small
      // loss, but a silent one is a puzzle later.
      failures.push({
        fileName: `logo:${target?.domain ?? row.id}`,
        reason: target ? "unreadable logo_url" : "company not migrated",
      });
      continue;
    }
    if (dryRun) {
      logosCopied.push(target.domain);
      continue;
    }
    try {
      const body = await downloadObject(ref.bucket, ref.objectPath);
      const fileName = ref.objectPath.split("/").pop() ?? "logo";
      const key = buildObjectKey({
        companyId: target.id.toHexString(),
        category: "logo",
        fileName,
        uniqueId: randomUUID(),
      });
      await putObjectBuffer(key, body, "image/png");
      await companies.updateOne(
        { _id: target.id },
        { $set: { logoKey: key, updatedAt: new Date() } },
      );
      logosCopied.push(target.domain);
    } catch (error) {
      failures.push({
        fileName: `logo:${target.domain}`,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
} finally {
  await client.close();
}

for (const failure of failures.slice(0, 15)) {
  console.warn(`  FAILED ${failure.fileName}: ${failure.reason}`);
}
if (failures.length > 15) console.warn(`  … and ${failures.length - 15} more`);

console.log(
  `\nplanned ${planned.length} · copied ${copied.length} · ` +
    `already present ${skippedExisting.length} · failed ${failures.length} · ` +
    `logos ${logosCopied.length}`,
);

if (dryRun) {
  console.log("\n[dry run] nothing was downloaded or uploaded");
  console.log(
    includeChatAttachments
      ? "chat attachments ARE included in this plan"
      : `chat attachments excluded (${kinds["chat-attachment"]} files); pass --include-chat-attachments to copy them too`,
  );
} else {
  await mkdir(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "phase-06-documents.json");
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        phase: "06-documents",
        ranAt: new Date().toISOString(),
        signedOffBy: cohort.signedOffBy,
        includeChatAttachments,
        kinds,
        totals: {
          planned: planned.length,
          copied: copied.length,
          alreadyPresent: skippedExisting.length,
          failed: failures.length,
          logos: logosCopied.length,
        },
        failures,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`wrote ${reportPath}`);
  console.log("\nNext: npm run ai:embed:company  (re-embeds the new files inline)");
}
