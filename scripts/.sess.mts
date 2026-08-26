import nextEnv from "@next/env";
nextEnv.loadEnvConfig(process.cwd());
const { MongoClient } = await import("mongodb");
const c = new MongoClient(process.env.MONGODB_URI!); await c.connect();
const db = c.db(process.env.MONGODB_DB || "bauai");

const sessions = await db.collection("fill_agent_sessions").find({}).sort({ _id: -1 }).limit(3).toArray();
console.log("fill_agent_sessions:", sessions.length);
for (const s of sessions) {
  console.log(" ", JSON.stringify({ id: String(s._id), doc: String(s.documentId ?? ""), status: s.status, stage: s.stage, file: s.fileName, created: s._id.getTimestamp() }));
}
if (sessions[0]) {
  const thread = await db.collection("chat_threads").findOne({ "threadKey": { $regex: String(sessions[0]._id) } });
  console.log("\nthread:", thread ? JSON.stringify({ id: String(thread._id), key: thread.threadKey }) : "none");
  if (thread) {
    const msgs = await db.collection("chat_messages").find({ threadId: thread._id }).sort({ _id: 1 }).toArray();
    console.log(`messages: ${msgs.length}`);
    for (const m of msgs.slice(-6)) {
      console.log(`  [${m.role}] status=${m.status} tools=${JSON.stringify((m.toolEvents ?? []).map((t: { name: string }) => t.name))}`);
      console.log(`     ${String(m.content ?? "").slice(0, 150)}`);
    }
  }
}
await c.close();
