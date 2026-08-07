/**
 * Runs a resolver against a live document URL and prints what it found, without
 * touching MongoDB or S3.
 *
 * This is how each platform resolver gets built: point it at a real portal page, see
 * which links are picked up, adjust the resolver, repeat.
 *
 *   npm run documents:inspect -- https://www.evergabe-online.de/tenderdetails.html?id=877058
 *   npm run documents:inspect -- <url> --html      # dump the fetched HTML
 *   npm run documents:inspect -- <url> --save fixtures/portals/evergabe-online.html
 *   npm run documents:inspect -- --sample 12       # pull real URLs out of MongoDB
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const { DocumentHttpClient } = await import("../lib/ingestion/documents/http.ts");
const { resolverFor, hasPlatformResolver, registeredPlatforms } = await import(
  "../lib/ingestion/documents/registry.ts"
);
const { isSkip } = await import("../lib/ingestion/documents/types.ts");
const { canExtractText } = await import("../lib/ingestion/documents/text-extract.ts");
const { finishProcess } = await import("../lib/ingestion/utils/exit.ts");

const sampleCount = flag("sample");
const dumpHtml = process.argv.includes("--html");
const savePath = flag("save");
const http = new DocumentHttpClient();

console.log(`registered platform resolvers: ${registeredPlatforms().join(", ") || "(none yet)"}`);

if (sampleCount) {
  await sampleFromDatabase(Number.parseInt(sampleCount, 10));
} else {
  const target = process.argv[2];
  if (!target || target.startsWith("--")) {
    console.error(
      "Usage: npm run documents:inspect -- <url> [--html] [--save <path>]\n" +
        "       npm run documents:inspect -- --sample <n>",
    );
    process.exit(1);
  }
  await inspect(target);
}

const { closeBrowser } = await import("../lib/ingestion/documents/browser.ts");
await closeBrowser();
finishProcess(0);

async function inspect(target: string): Promise<void> {
  const url = new URL(target);
  const resolver = resolverFor(url);

  console.log(`\n=== ${url.host}`);
  console.log(`  url       ${target}`);
  console.log(
    `  resolver  ${resolver.platform}${hasPlatformResolver(url) ? "" : " (generic fallback)"}`,
  );

  if (dumpHtml || savePath) {
    try {
      const page = await http.html(target);
      if (savePath) {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(savePath, page.body, "utf8");
        console.log(`  saved     ${savePath} (${page.body.length} bytes)`);
      }
      if (dumpHtml) console.log(page.body);
    } catch (error) {
      console.error(`  html fetch failed: ${String(error).slice(0, 200)}`);
    }
  }

  const startedAt = Date.now();
  try {
    const outcome = await resolver.resolve({ url, http });

    if (isSkip(outcome)) {
      console.log(`  RESULT    SKIP ${outcome.skip}${outcome.detail ? ` — ${outcome.detail}` : ""}`);
      return;
    }

    console.log(`  RESULT    ${outcome.files.length} file(s) in ${Date.now() - startedAt}ms`);

    for (const file of outcome.files.slice(0, 25)) {
      // A HEAD per candidate confirms the link is really a file before a resolver is
      // declared working; a page returning HTML here means the selector is too loose.
      let detail = "";
      try {
        const head = await http.head(file.url);
        const extractable = canExtractText(head.mimeType, file.fileName ?? "");
        detail = `${head.mimeType || "?"} ${
          head.byteLength ? `${Math.round(head.byteLength / 1024)}KB` : "?"
        }${extractable ? " text:yes" : " text:no"}`;
      } catch (error) {
        detail = `HEAD failed: ${String(error).slice(0, 60)}`;
      }
      console.log(`    - ${file.fileName ?? "(no name)"} | ${detail}`);
      console.log(`      ${file.url.slice(0, 150)}`);
      if (file.label) console.log(`      label: ${file.label.slice(0, 100)}`);
    }
  } catch (error) {
    console.error(`  RESULT    ERROR ${String(error).slice(0, 300)}`);
  }
}

/** Pulls real document URLs from `tender_documents`, one per host, newest first. */
async function sampleFromDatabase(count: number): Promise<void> {
  const { documentStore } = await import("../lib/ingestion/documents/records.ts");
  const { closeIngestionClient } = await import("../lib/ingestion/db/client.ts");

  try {
    const store = await documentStore();
    const rows = await store
      .aggregate<{ _id: string; url: string; total: number }>([
        { $sort: { createdAt: -1 } },
        { $group: { _id: "$host", url: { $first: "$sourceUrl" }, total: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: count },
      ])
      .toArray();

    if (!rows.length) {
      console.log("\nNo document rows yet. Seed some tenders first.");
      return;
    }

    console.log(`\nTop ${rows.length} hosts by document count:`);
    for (const row of rows) console.log(`  ${String(row.total).padStart(5)}  ${row._id}`);

    for (const row of rows) await inspect(row.url);
  } finally {
    await closeIngestionClient();
  }
}
