/**
 * Persistence test suite from architecture section 17.3.
 *
 * Runs against a real MongoDB replica set in a throwaway database, exercising the
 * transactional writer, the projection rules, cross-source linking, and the outbox.
 * Object storage is not involved: a raw payload reference is supplied directly, so
 * these checks stay focused on what MongoDB guarantees.
 *
 *   npm run ingestion:verify
 *   MONGODB_URI=mongodb://127.0.0.1:27018/?replicaSet=rs0 npm run ingestion:verify
 */
import { readFileSync } from "node:fs";

import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

// A dedicated database keeps the suite from touching development data; it is
// dropped on the way out.
process.env.MONGODB_DB = process.env.INGESTION_VERIFY_DB || "bauai_ingestion_verify";

const { closeIngestionClient, getIngestionDb, assertReplicaSet } = await import(
  "../lib/ingestion/db/client.ts"
);
const { getCollections } = await import("../lib/ingestion/db/collections.ts");
const { ensureIngestionIndexes } = await import("../lib/ingestion/db/indexes.ts");
const { parseEformsNotice } = await import("../lib/ingestion/eforms/parse-notice.ts");
const { computeCanonicalKey } = await import("../lib/ingestion/pipeline/projection.ts");
const { writeNotice } = await import("../lib/ingestion/pipeline/writer.ts");
const { deriveStatus } = await import("../lib/ingestion/pipeline/status.ts");
const { sha256 } = await import("../lib/ingestion/utils/hash.ts");

type SourceNotice = Awaited<ReturnType<typeof parseEformsNotice>>;
type RawPayloadRef = Parameters<typeof writeNotice>[0]["raw"];

const fixtureDir = process.argv[2] ?? "./fixtures/de";
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  [pass] ${name}`);
  } else {
    failed += 1;
    console.error(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Builds a notice from a fixture, overriding source identity as needed. */
function noticeFrom(
  file: string,
  overrides: {
    source?: "DE_BUND" | "TED";
    noticeId?: string;
    versionKey?: string;
    procedureId?: string | null;
    publishedAt?: Date;
    typeCode?: string;
    businessCategory?: SourceNotice["notice"]["businessCategory"];
    title?: string;
    isAwarded?: boolean;
    isCancelled?: boolean;
  } = {},
): { notice: SourceNotice; raw: RawPayloadRef; contentSha256: string } {
  const body = readFileSync(file);
  const contentSha256 = sha256(body + (overrides.versionKey ?? ""));

  const parsed = parseEformsNotice(
    {
      source: overrides.source ?? "DE_BUND",
      sourceNoticeId: overrides.noticeId ?? "fixture-notice",
      body,
      mimeType: "application/xml",
      sha256: contentSha256,
      byteLength: body.byteLength,
      fetchedAt: new Date(),
      url: "https://example.invalid/notice",
      licence: "test",
    },
    {
      source: overrides.source ?? "DE_BUND",
      sourceNoticeId: overrides.noticeId ?? "fixture-notice",
      sourceVersionId: null,
      versionKey: overrides.versionKey ?? "v1",
      publicationNumber: null,
      procedureId: null,
      url: "https://example.invalid/notice",
      publishedAt: overrides.publishedAt ?? new Date("2026-08-04T10:00:00Z"),
      updatedAtSource: null,
    },
    { versionKey: overrides.versionKey ?? "v1", discoveredUrl: null },
  );

  const notice: SourceNotice = {
    ...parsed,
    source: {
      ...parsed.source,
      code: overrides.source ?? "DE_BUND",
      noticeId: overrides.noticeId ?? parsed.source.noticeId,
      versionKey: overrides.versionKey ?? "v1",
      procedureId:
        overrides.procedureId !== undefined
          ? overrides.procedureId
          : parsed.source.procedureId,
    },
    notice: {
      ...parsed.notice,
      typeCode: overrides.typeCode ?? parsed.notice.typeCode,
      businessCategory: overrides.businessCategory ?? parsed.notice.businessCategory,
    },
    snapshot: {
      ...parsed.snapshot,
      title: overrides.title
        ? { ...parsed.snapshot.title, original: overrides.title }
        : parsed.snapshot.title,
      isAwarded: overrides.isAwarded ?? parsed.snapshot.isAwarded,
      isCancelled: overrides.isCancelled ?? parsed.snapshot.isCancelled,
    },
    publication: {
      ...parsed.publication,
      publishedAt: overrides.publishedAt ?? parsed.publication.publishedAt,
    },
  };

  const raw: RawPayloadRef = {
    storage: "s3",
    bucket: "verify",
    key: `verify/${notice.source.code}/${notice.source.noticeId}/${notice.source.versionKey}`,
    mimeType: "application/xml",
    compression: "gzip",
    byteLength: body.byteLength,
    sha256: contentSha256,
  };

  return { notice, raw, contentSha256 };
}

function write(notice: SourceNotice, raw: RawPayloadRef, mode: "live" | "backfill" = "live") {
  return writeNotice({
    notice,
    raw,
    discoveredAt: new Date(),
    fetchedAt: new Date(),
    mode,
  });
}

let fixture: string;
try {
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(fixtureDir).filter((f) => f.endsWith(".xml"));
  if (!files.length) throw new Error("no .xml fixtures");
  fixture = `${fixtureDir}/${files[0]}`;
} catch (error) {
  console.error(
    `Could not read fixtures from ${fixtureDir}: ${String(error)}\n` +
      `Pass a directory of eForms XML files: npm run ingestion:verify -- <dir>`,
  );
  process.exit(1);
}

console.log(`Using fixture: ${fixture}`);

try {
  await assertReplicaSet();
  const db = await getIngestionDb();
  await db.dropDatabase();
  await ensureIngestionIndexes();
  const collections = await getCollections();

  /* ------------------------------------------------------------------ */
  console.log("\n1. Concurrent delivery of the same job yields one source version");
  {
    const { notice, raw } = noticeFrom(fixture, {
      noticeId: "concurrent-1",
      procedureId: "10000000-0000-4000-8000-000000000001",
    });
    const results = await Promise.all([
      write(notice, raw),
      write(notice, raw),
      write(notice, raw),
      write(notice, raw),
    ]);

    const stored = await collections.tenderNotices.countDocuments({
      "source.noticeId": "concurrent-1",
    });
    check("exactly one tender_notices document", stored === 1, `found ${stored}`);

    const inserts = results.filter((r) => r.outcome === "INSERTED").length;
    check("exactly one writer reports INSERTED", inserts === 1, `got ${inserts}`);

    const tenders = await collections.tenders.countDocuments({
      canonicalKey: computeCanonicalKey(notice),
    });
    check("exactly one tenders projection", tenders === 1, `found ${tenders}`);
  }

  /* ------------------------------------------------------------------ */
  console.log("\n2. Reprocessing the same version is UNCHANGED, not a duplicate");
  {
    const { notice, raw } = noticeFrom(fixture, {
      noticeId: "unchanged-1",
      procedureId: "20000000-0000-4000-8000-000000000002",
    });
    await write(notice, raw);
    const second = await write(notice, raw);

    check("second write reports UNCHANGED", second.outcome === "UNCHANGED", second.outcome);
    const stored = await collections.tenderNotices.countDocuments({
      "source.noticeId": "unchanged-1",
    });
    check("still one source version", stored === 1, `found ${stored}`);
  }

  /* ------------------------------------------------------------------ */
  console.log("\n3. A corrected version keeps history and advances the projection");
  {
    const first = noticeFrom(fixture, {
      noticeId: "versioned-1",
      versionKey: "v1",
      procedureId: "30000000-0000-4000-8000-000000000003",
      title: "Original title",
      publishedAt: new Date("2026-08-01T09:00:00Z"),
    });
    const second = noticeFrom(fixture, {
      noticeId: "versioned-1",
      versionKey: "v2",
      procedureId: "30000000-0000-4000-8000-000000000003",
      title: "Corrected title",
      publishedAt: new Date("2026-08-03T09:00:00Z"),
    });

    await write(first.notice, first.raw);
    const result = await write(second.notice, second.raw);

    const versions = await collections.tenderNotices.countDocuments({
      "source.noticeId": "versioned-1",
    });
    check("both immutable versions retained", versions === 2, `found ${versions}`);
    check("second write reports INSERTED", result.outcome === "INSERTED", result.outcome);

    const tender = await collections.tenders.findOne({
      canonicalKey: computeCanonicalKey(second.notice),
    });
    check("projection shows the corrected title", tender?.title === "Corrected title", tender?.title ?? "null");
    check("projection references both versions", tender?.noticeRefs.length === 2, String(tender?.noticeRefs.length));
    check(
      "currentVersionKey points at the newer version",
      tender?.currentVersionKey === "v2",
      tender?.currentVersionKey,
    );
  }

  /* ------------------------------------------------------------------ */
  console.log("\n4. An older version arriving late does not regress the projection");
  {
    const newer = noticeFrom(fixture, {
      noticeId: "stale-1",
      versionKey: "v2",
      procedureId: "40000000-0000-4000-8000-000000000004",
      title: "Newer title",
      publishedAt: new Date("2026-08-04T09:00:00Z"),
    });
    const older = noticeFrom(fixture, {
      noticeId: "stale-1",
      versionKey: "v1",
      procedureId: "40000000-0000-4000-8000-000000000004",
      title: "Older title",
      publishedAt: new Date("2026-08-01T09:00:00Z"),
    });

    await write(newer.notice, newer.raw);
    await write(older.notice, older.raw, "backfill");

    const tender = await collections.tenders.findOne({
      canonicalKey: computeCanonicalKey(newer.notice),
    });
    check("projection keeps the newer title", tender?.title === "Newer title", tender?.title ?? "null");
    check("both versions still stored", tender?.noticeRefs.length === 2, String(tender?.noticeRefs.length));
  }

  /* ------------------------------------------------------------------ */
  console.log("\n5. An award advances the lifecycle without erasing the opportunity");
  {
    const procedureId = "11111111-2222-4333-8444-555555555555";
    const competition = noticeFrom(fixture, {
      noticeId: "lifecycle-cn",
      versionKey: "v1",
      procedureId,
      typeCode: "cn-standard",
      businessCategory: "OPEN_OPPORTUNITY",
      title: "Bridge renovation works",
      publishedAt: new Date("2026-07-01T09:00:00Z"),
    });
    const award = noticeFrom(fixture, {
      noticeId: "lifecycle-can",
      versionKey: "v1",
      procedureId,
      typeCode: "can-standard",
      businessCategory: "AWARD_RESULT",
      title: "Award notice - bridge renovation",
      isAwarded: true,
      publishedAt: new Date("2026-08-01T09:00:00Z"),
    });

    await write(competition.notice, competition.raw);
    await write(award.notice, award.raw);

    const key = computeCanonicalKey(award.notice);
    check("both notices share one canonical key", key === computeCanonicalKey(competition.notice), key);

    const tender = await collections.tenders.findOne({ canonicalKey: key });
    check("one aggregate for the procedure", tender !== null);
    check(
      "opportunity title preserved through the award",
      tender?.title === "Bridge renovation works",
      tender?.title ?? "null",
    );
    check("status advanced to AWARDED", tender?.status === "AWARDED", tender?.status);
    check("both notices referenced", tender?.noticeRefs.length === 2, String(tender?.noticeRefs.length));
  }

  /* ------------------------------------------------------------------ */
  console.log("\n6. National and TED notices link only on a strong identifier");
  {
    const procedureId = "99999999-8888-4777-8666-555555555555";
    const national = noticeFrom(fixture, {
      noticeId: "de-linked",
      versionKey: "v1",
      procedureId,
      source: "DE_BUND",
      publishedAt: new Date("2026-07-10T09:00:00Z"),
    });
    const ted = noticeFrom(fixture, {
      noticeId: "ted-linked",
      versionKey: "v1",
      procedureId,
      source: "TED",
      publishedAt: new Date("2026-07-11T09:00:00Z"),
    });

    await write(national.notice, national.raw);
    await write(ted.notice, ted.raw);

    const tender = await collections.tenders.findOne({
      canonicalKey: computeCanonicalKey(ted.notice),
    });
    check("linked into one aggregate", tender?.noticeRefs.length === 2, String(tender?.noticeRefs.length));
    check(
      "both official source records retained",
      (await collections.tenderNotices.countDocuments({
        "source.procedureId": procedureId,
      })) === 2,
    );
    const sources = new Set(tender?.noticeRefs.map((ref) => ref.source));
    check("both sources present on the aggregate", sources.has("DE_BUND") && sources.has("TED"));
  }

  /* ------------------------------------------------------------------ */
  console.log("\n7. Similar notices without a shared identifier are NOT merged");
  {
    const a = noticeFrom(fixture, {
      noticeId: "similar-a",
      versionKey: "v1",
      procedureId: "aaaaaaaa-1111-4111-8111-111111111111",
      title: "Identical title, different procedure",
    });
    const b = noticeFrom(fixture, {
      noticeId: "similar-b",
      versionKey: "v1",
      procedureId: "bbbbbbbb-2222-4222-8222-222222222222",
      title: "Identical title, different procedure",
    });

    await write(a.notice, a.raw);
    await write(b.notice, b.raw);

    const keyA = computeCanonicalKey(a.notice);
    const keyB = computeCanonicalKey(b.notice);
    check("canonical keys differ", keyA !== keyB, `${keyA} vs ${keyB}`);
    check(
      "two separate aggregates",
      (await collections.tenders.countDocuments({ canonicalKey: { $in: [keyA, keyB] } })) === 2,
    );
  }

  /* ------------------------------------------------------------------ */
  console.log("\n8. Outbox events are versioned, unique, and typed correctly");
  {
    const { notice, raw } = noticeFrom(fixture, {
      noticeId: "outbox-1",
      versionKey: "v1",
      procedureId: "80000000-0000-4000-8000-000000000008",
      typeCode: "cn-standard",
      businessCategory: "OPEN_OPPORTUNITY",
    });
    const created = await write(notice, raw);

    const events = await collections.outboxEvents
      .find({ aggregateId: created.tenderId! })
      .sort({ aggregateVersion: 1 })
      .toArray();

    check("one event for the insert", events.length === 1, String(events.length));
    check("event type is TENDER_CREATED", events[0]?.eventType === "TENDER_CREATED", events[0]?.eventType);
    check("aggregateVersion starts at 1", events[0]?.aggregateVersion === 1, String(events[0]?.aggregateVersion));
    check("event is undelivered", events[0]?.deliveredAt === null);

    const second = noticeFrom(fixture, {
      noticeId: "outbox-1",
      versionKey: "v2",
      procedureId: "80000000-0000-4000-8000-000000000008",
      typeCode: "can-standard",
      businessCategory: "AWARD_RESULT",
      isAwarded: true,
      publishedAt: new Date("2026-08-05T09:00:00Z"),
    });
    await write(second.notice, second.raw);

    const after = await collections.outboxEvents
      .find({ aggregateId: created.tenderId! })
      .sort({ aggregateVersion: 1 })
      .toArray();
    check("a second event was emitted", after.length === 2, String(after.length));
    check(
      "status change is reported as TENDER_STATUS_CHANGED",
      after[1]?.eventType === "TENDER_STATUS_CHANGED",
      after[1]?.eventType,
    );
  }

  /* ------------------------------------------------------------------ */
  console.log("\n9. Backfill inserts suppress user notifications unless still open");
  {
    const closed = noticeFrom(fixture, {
      noticeId: "backfill-closed",
      versionKey: "v1",
      procedureId: "cccccccc-3333-4333-8333-333333333333",
      typeCode: "can-standard",
      businessCategory: "AWARD_RESULT",
      isAwarded: true,
    });
    const result = await write(closed.notice, closed.raw, "backfill");
    const event = await collections.outboxEvents.findOne({ aggregateId: result.tenderId! });
    check(
      "historical award suppresses notifications",
      event?.payload.suppressNotifications === true,
      String(event?.payload.suppressNotifications),
    );
  }

  /* ------------------------------------------------------------------ */
  console.log("\n10. The unique source/version index rejects a duplicate directly");
  {
    let rejected = false;
    try {
      const { notice } = noticeFrom(fixture, {
        noticeId: "index-1",
        versionKey: "v1",
        procedureId: "90000000-0000-4000-8000-000000000009",
      });
      const doc = await collections.tenderNotices.findOne({});
      if (!doc) throw new Error("no notice to clone");
      await collections.tenderNotices.insertOne({
        ...doc,
        _id: undefined as never,
        source: {
          ...doc.source,
          code: notice.source.code,
          noticeId: doc.source.noticeId,
          versionKey: doc.source.versionKey,
        },
      });
    } catch (error) {
      rejected = (error as { code?: number }).code === 11000;
    }
    check("duplicate insert rejected by unique index", rejected);
  }

  /* ------------------------------------------------------------------ */
  console.log("\n11. Status derivation honours deadlines and cancellation");
  {
    const now = new Date("2026-08-05T12:00:00Z");
    check(
      "future deadline is OPEN",
      deriveStatus({
        businessCategory: "OPEN_OPPORTUNITY",
        submissionDeadline: new Date("2026-09-01T12:00:00Z"),
        isCancelled: false,
        isAwarded: false,
        now,
      }) === "OPEN",
    );
    check(
      "near deadline is CLOSING_SOON",
      deriveStatus({
        businessCategory: "OPEN_OPPORTUNITY",
        submissionDeadline: new Date("2026-08-06T12:00:00Z"),
        isCancelled: false,
        isAwarded: false,
        now,
      }) === "CLOSING_SOON",
    );
    check(
      "past deadline is CLOSED",
      deriveStatus({
        businessCategory: "OPEN_OPPORTUNITY",
        submissionDeadline: new Date("2026-08-04T12:00:00Z"),
        isCancelled: false,
        isAwarded: false,
        now,
      }) === "CLOSED",
    );
    check(
      "cancellation outranks an open deadline",
      deriveStatus({
        businessCategory: "OPEN_OPPORTUNITY",
        submissionDeadline: new Date("2026-09-01T12:00:00Z"),
        isCancelled: true,
        isAwarded: false,
        now,
      }) === "CANCELLED",
    );
    check(
      "unknown deadline keeps the category default",
      deriveStatus({
        businessCategory: "OPEN_OPPORTUNITY",
        submissionDeadline: null,
        isCancelled: false,
        isAwarded: false,
        now,
      }) === "OPEN",
    );
    check(
      "VEAT is a direct award, never open",
      deriveStatus({
        businessCategory: "DIRECT_AWARD_NOTICE",
        submissionDeadline: new Date("2026-09-01T12:00:00Z"),
        isCancelled: false,
        isAwarded: false,
        now,
      }) === "DIRECT_AWARD",
    );
  }

  await db.dropDatabase();
} finally {
  await closeIngestionClient();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
