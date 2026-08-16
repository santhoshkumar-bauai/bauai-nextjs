/**
 * Copies a one-time snapshot of the local `bauai` database to the remote VM.
 *
 * MongoDB Database Tools are used so BSON types, indexes, validators, and other
 * collection metadata survive the copy. Matching destination collections are
 * replaced; collections that do not exist in the source are left untouched.
 *
 * PowerShell:
 *   $env:MONGODB_REPLICA_TARGET_PASSWORD = "the Dokploy password"
 *   npm run db:replicate -- --replace
 *
 * Use --dry-run to validate configuration and tool availability without making
 * a connection or changing either database.
 */
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DATABASE = process.env.MONGODB_REPLICA_DATABASE ?? "bauai";
const SOURCE_URI =
  process.env.MONGODB_REPLICA_SOURCE_URI ??
  "mongodb://localhost:27018/bauai?directConnection=true";

const replace = process.argv.includes("--replace");
const dryRun = process.argv.includes("--dry-run");

if (!/^[A-Za-z0-9_-]+$/.test(DATABASE)) {
  throw new Error(
    "MONGODB_REPLICA_DATABASE may contain only letters, numbers, underscores, and hyphens.",
  );
}

function targetUri(): string {
  const explicitUri = process.env.MONGODB_REPLICA_TARGET_URI;
  if (explicitUri) {
    if (explicitUri.includes("<URL_ENCODED_PASSWORD>")) {
      throw new Error(
        "MONGODB_REPLICA_TARGET_URI still contains the <URL_ENCODED_PASSWORD> placeholder.",
      );
    }
    return explicitUri;
  }

  const password = "kFaTGEj9OTvCA0OfEOzd";
  if (!password) {
    throw new Error(
      "Set MONGODB_REPLICA_TARGET_PASSWORD before running this script. " +
        "The script URL-encodes it automatically.",
    );
  }

  const username = process.env.MONGODB_REPLICA_TARGET_USERNAME ?? "admin";
  const host = process.env.MONGODB_REPLICA_TARGET_HOST ?? "34.68.209.243:27017";
  const authSource = process.env.MONGODB_REPLICA_AUTH_SOURCE ?? "admin";

  return (
    `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}` +
    `@${host}/?authSource=${encodeURIComponent(authSource)}&directConnection=true`
  );
}

function findTool(
  name: "mongodump" | "mongorestore",
  environmentOverride: string | undefined,
): string {
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  const candidates = [
    environmentOverride,
    executable,
    process.platform === "win32"
      ? `C:/Program Files/MongoDB/Tools/100/bin/${executable}`
      : undefined,
    `/usr/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const isPath = candidate.includes("/") || candidate.includes("\\");
    if (isPath && !existsSync(candidate)) continue;

    const probe = spawnSync(candidate, ["--version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (!probe.error && probe.status === 0) return candidate;
  }

  const override =
    name === "mongodump" ? "MONGODUMP_PATH" : "MONGORESTORE_PATH";
  throw new Error(
    `Could not find ${name}. Install MongoDB Database Tools or set ${override} to its executable.`,
  );
}

function runTool(command: string, args: string[], label: string): void {
  console.log(`\n${label}...`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    windowsHide: true,
  });

  if (result.error)
    throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with exit code ${result.status ?? "unknown"}.`,
    );
  }
}

async function writeToolConfig(filePath: string, uri: string): Promise<void> {
  // Database Tools accepts JSON-style quoted strings in its YAML config. Keeping
  // the URI in a protected temporary file prevents the password appearing in the
  // process list or command output.
  await writeFile(filePath, `uri: ${JSON.stringify(uri)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(filePath, 0o600).catch(() => undefined);
}

const destinationUri = targetUri();
const mongodump = findTool("mongodump", process.env.MONGODUMP_PATH);
const mongorestore = findTool("mongorestore", process.env.MONGORESTORE_PATH);

console.log("MongoDB snapshot replication");
console.log(`  database     ${DATABASE}`);
console.log("  source       localhost:27018");
console.log(
  `  destination ${process.env.MONGODB_REPLICA_TARGET_HOST ?? "34.68.209.243:27017"}`,
);
console.log(
  `  mode         ${dryRun ? "dry run" : "replace matching collections"}`,
);

if (dryRun) {
  console.log("\n[ok] Configuration and MongoDB Database Tools are available.");
  process.exit(0);
}

if (!replace) {
  throw new Error(
    "Replication replaces matching destination collections. Re-run with --replace to confirm.",
  );
}

const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "bauai-mongo-replica-"),
);
const sourceConfig = path.join(temporaryDirectory, "source.yml");
const destinationConfig = path.join(temporaryDirectory, "destination.yml");
const archive = path.join(temporaryDirectory, "bauai.archive.gz");

try {
  await writeToolConfig(sourceConfig, SOURCE_URI);
  await writeToolConfig(destinationConfig, destinationUri);

  runTool(
    mongodump,
    [
      `--config=${sourceConfig}`,
      `--archive=${archive}`,
      "--gzip",
      `--db=${DATABASE}`,
    ],
    "Creating local snapshot",
  );

  runTool(
    mongorestore,
    [
      `--config=${destinationConfig}`,
      `--archive=${archive}`,
      "--gzip",
      "--drop",
      "--stopOnError",
      `--nsInclude=${DATABASE}.*`,
    ],
    "Restoring snapshot to the VM",
  );

  console.log(`\n[ok] Replicated ${DATABASE} to the remote MongoDB instance.`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
