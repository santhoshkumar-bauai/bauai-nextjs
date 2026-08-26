// Throwaway watcher for the live 25-page fill run (deleted after the smoke).
import nextEnv from "@next/env";
import { MongoClient, ObjectId } from "mongodb";

nextEnv.loadEnvConfig(process.cwd());

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const col = client.db(process.env.MONGODB_DB || "bauai").collection("fill_agent_sessions");
const docId = new ObjectId("6a8e9d1bf2e0c22270d08d8f");

let last = "";
for (;;) {
  const s = await col.findOne({ documentId: docId }, { sort: { createdAt: -1 } });
  if (s) {
    const errors = s.issues.filter((i) => i.severity === "error").length;
    const warnings = s.issues.filter((i) => i.severity === "warning").length;
    const line = `status=${s.status} rounds=${s.fillIterations}/${s.maxFillIterations} score=${s.score} fields=${s.fieldmap.length} errors=${errors} warnings=${warnings}`;
    if (line !== last) {
      console.log(line);
      last = line;
    }
    if (["filled", "escalated", "failed"].includes(s.status)) break;
  }
  await new Promise((r) => setTimeout(r, 20_000));
}
await client.close();
process.exit(0);
