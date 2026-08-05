/**
 * Starts a local single-node MongoDB replica set for development, without Docker.
 *
 * The ingestion writer needs a replica set: transactions and change streams are not
 * available on a standalone `mongod` (§6.1). This starts one on its own data
 * directory and port, so an existing MongoDB service is left untouched.
 *
 *   npm run mongo:dev                     # port 27017, data in ./.mongo-dev
 *   npm run mongo:dev -- --port 27018
 *   npm run mongo:dev -- --dbpath /tmp/rs
 *
 * Runs in the foreground; Ctrl-C shuts it down cleanly.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { MongoClient } from "mongodb";

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const port = Number.parseInt(flag("port", "27017"), 10);
const replSet = flag("replset", "rs0");
const dbPath = path.resolve(flag("dbpath", ".mongo-dev/data"));

/**
 * Locates a runnable mongod. Windows installers do not add it to PATH, so each
 * candidate is actually executed rather than assumed — a bare `mongod` that is not
 * on PATH fails later with a bare ENOENT, which is a confusing way to learn this.
 */
function findMongod(): string {
  const candidates = [
    process.env.MONGOD_PATH,
    "mongod",
    ...["8.2", "8.1", "8.0", "7.0", "6.0"].flatMap((version) => [
      `C:/Program Files/MongoDB/Server/${version}/bin/mongod.exe`,
      `/usr/local/mongodb/${version}/bin/mongod`,
    ]),
    "/usr/bin/mongod",
    "/usr/local/bin/mongod",
    "/opt/homebrew/bin/mongod",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    // An absolute path that does not exist cannot be run; skip without spawning.
    if (candidate.includes("/") && !existsSync(candidate)) continue;

    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!probe.error && probe.status === 0) return candidate;
  }

  throw new Error(
    "Could not find a runnable mongod. Install MongoDB Server, or set MONGOD_PATH to its binary, " +
      'for example MONGOD_PATH="C:/Program Files/MongoDB/Server/8.2/bin/mongod.exe".',
  );
}

async function alreadyUsable(): Promise<boolean> {
  const client = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, {
    serverSelectionTimeoutMS: 1_500,
  });
  try {
    await client.connect();
    const hello = await client.db("admin").command({ hello: 1 });
    if (hello.setName) {
      console.log(`[ok] a replica set (${hello.setName}) is already running on ${port}`);
      console.log(`\nMONGODB_URI=mongodb://127.0.0.1:${port}/bauai?replicaSet=${hello.setName}&directConnection=true`);
      return true;
    }
    // A standalone on this port would have to be reconfigured or moved aside; that
    // is the operator's call, so this exits rather than touching it.
    throw new Error(
      `A standalone mongod is already running on port ${port}. Stop it, or pass --port to use another.`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("standalone mongod")) throw error;
    return false;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function waitForPrimary(client: MongoClient): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const hello = await client.db("admin").command({ hello: 1 });
      if (hello.isWritablePrimary) return;
    } catch {
      // Not accepting connections yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Timed out waiting for the replica set to elect a primary.");
}

if (await alreadyUsable()) process.exit(0);

mkdirSync(dbPath, { recursive: true });
const mongod = findMongod();

console.log(`Starting ${mongod}`);
console.log(`  port     ${port}`);
console.log(`  replSet  ${replSet}`);
console.log(`  dbpath   ${dbPath}\n`);

const child = spawn(
  mongod,
  [
    "--replSet",
    replSet,
    "--port",
    String(port),
    "--dbpath",
    dbPath,
    "--bind_ip",
    "127.0.0.1",
    // A dev instance does not need a full-size cache and this keeps it neighbourly.
    "--wiredTigerCacheSizeGB",
    "0.5",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

child.stdout.on("data", (chunk: Buffer) => {
  for (const line of chunk.toString().trim().split("\n")) {
    try {
      const parsed = JSON.parse(line) as { s?: string; c?: string; msg?: string };
      if (parsed.s === "E" || parsed.s === "F") console.error(`  mongod: ${parsed.msg}`);
    } catch {
      // Non-JSON startup banner; not worth surfacing.
    }
  }
});
child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`  mongod: ${chunk}`));
// Without this, a spawn failure raises an unhandled 'error' event and the process
// dies with a stack trace instead of an explanation.
child.on("error", (error) => {
  console.error(`\nCould not start mongod (${mongod}): ${error.message}`);
  process.exit(1);
});
child.on("exit", (code) => {
  if (code) {
    console.error(`\nmongod exited with code ${code}. Check for a port clash or a locked dbpath.`);
    process.exit(code);
  }
});

const client = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, {
  serverSelectionTimeoutMS: 30_000,
});

try {
  await client.connect();

  try {
    await client.db("admin").command({
      replSetInitiate: {
        _id: replSet,
        members: [{ _id: 0, host: `127.0.0.1:${port}` }],
      },
    });
    console.log(`[ok] initiated replica set ${replSet}`);
  } catch (error) {
    // Re-running against an existing data directory is normal and not an error.
    const message = error instanceof Error ? error.message : String(error);
    if (!/already initialized|AlreadyInitialized/i.test(message)) throw error;
    console.log(`[ok] replica set ${replSet} was already initiated`);
  }

  await waitForPrimary(client);
  console.log("[ok] primary ready\n");
  console.log("Add this to .env.local:");
  console.log(`  MONGODB_URI=mongodb://127.0.0.1:${port}/bauai?replicaSet=${replSet}&directConnection=true\n`);
  console.log("Then, in another terminal:");
  console.log("  npm run ingestion:bootstrap");
  console.log("  npm run seed:tenders -- --dry-run\n");
  console.log("Leave this running. Ctrl-C stops mongod.");
} catch (error) {
  console.error(`\nFailed to initiate the replica set: ${String(error)}`);
  child.kill("SIGTERM");
  process.exit(1);
} finally {
  await client.close().catch(() => undefined);
}

const shutdown = () => {
  console.log("\nStopping mongod...");
  child.kill("SIGTERM");
  // mongod flushes and closes its files on SIGTERM; give it room before exiting.
  setTimeout(() => process.exit(0), 3_000);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
