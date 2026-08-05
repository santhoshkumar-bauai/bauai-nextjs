/**
 * Parses a local eForms XML file through the shared parser and prints the
 * canonical result. Used to review parser output against fixtures (§17.2)
 * without touching MongoDB, Redis, or S3.
 *
 *   npm run ingestion:parse -- ./fixtures/de/notice.xml
 */
import { readFileSync, statSync, readdirSync } from "node:fs";
import path from "node:path";

import { parseEformsNotice } from "../lib/ingestion/eforms/parse-notice.ts";
import type { DiscoveredNotice, RawNotice, TenderSourceCode } from "../lib/ingestion/types.ts";
import { sha256 } from "../lib/ingestion/utils/hash.ts";

const target = process.argv[2];
if (!target) {
  console.error("Usage: npm run ingestion:parse -- <file-or-directory.xml> [--summary]");
  process.exit(1);
}

const summaryOnly = process.argv.includes("--summary");
const source = (process.env.FIXTURE_SOURCE as TenderSourceCode) || "DE_BUND";

const files = statSync(target).isDirectory()
  ? readdirSync(target)
      .filter((name) => name.endsWith(".xml"))
      .map((name) => path.join(target, name))
  : [target];

let parsed = 0;
let failed = 0;
const typeCounts = new Map<string, number>();
const warningCounts = new Map<string, number>();

for (const file of files) {
  const body = readFileSync(file);
  const contentSha256 = sha256(body);

  const raw: RawNotice = {
    source,
    sourceNoticeId: path.basename(file, ".xml"),
    body,
    mimeType: "application/xml",
    sha256: contentSha256,
    byteLength: body.byteLength,
    fetchedAt: new Date(),
    url: null,
    licence: "fixture",
  };

  const ref: DiscoveredNotice = {
    source,
    sourceNoticeId: raw.sourceNoticeId,
    sourceVersionId: null,
    versionKey: null,
    publicationNumber: null,
    procedureId: null,
    url: null,
    publishedAt: null,
    updatedAtSource: null,
  };

  try {
    const notice = parseEformsNotice(raw, ref, {
      versionKey: contentSha256.slice(0, 16),
      discoveredUrl: null,
    });
    parsed += 1;
    typeCounts.set(notice.notice.typeCode, (typeCounts.get(notice.notice.typeCode) ?? 0) + 1);
    for (const warning of notice.processing.warnings) {
      const key = warning.split(":")[0];
      warningCounts.set(key, (warningCounts.get(key) ?? 0) + 1);
    }

    if (!summaryOnly) {
      console.log(
        JSON.stringify(
          {
            file: path.basename(file),
            source: notice.source,
            notice: notice.notice,
            publication: notice.publication,
            title: notice.snapshot.title.original,
            buyer: notice.snapshot.buyer?.name,
            cpvCodes: notice.snapshot.cpvCodes,
            countries: notice.snapshot.countries,
            regions: notice.snapshot.regions,
            value: notice.snapshot.value,
            submissionDeadline: notice.snapshot.submissionDeadline,
            lots: notice.snapshot.lots.length,
            documents: notice.snapshot.documents.length,
            relatedNoticeIds: notice.snapshot.relatedNoticeIds,
            isAwarded: notice.snapshot.isAwarded,
            isCancelled: notice.snapshot.isCancelled,
            warnings: notice.processing.warnings,
          },
          null,
          2,
        ),
      );
    }
  } catch (error) {
    failed += 1;
    console.error(`FAILED ${path.basename(file)}: ${String(error)}`);
  }
}

console.log(
  JSON.stringify(
    {
      parsed,
      failed,
      noticeTypes: Object.fromEntries([...typeCounts].sort((a, b) => b[1] - a[1])),
      warnings: Object.fromEntries([...warningCounts].sort((a, b) => b[1] - a[1])),
    },
    null,
    2,
  ),
);
