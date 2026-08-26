import nextEnv from "@next/env";
nextEnv.loadEnvConfig(process.cwd());
const { MongoClient, ObjectId } = await import("mongodb");
const c = new MongoClient(process.env.MONGODB_URI!); await c.connect();
const db = c.db(process.env.MONGODB_DB || "bauai");
const SID = "6a8e76e5870b016217432c18";
const thread = await db.collection("chat_threads").findOne({ threadKey: { $regex: SID } });
const msgs = await db.collection("chat_messages").find({ threadId: thread!._id }).sort({ _id: 1 }).toArray();
console.log(`messages: ${msgs.length}`);
for (const m of msgs.slice(-4)) {
  console.log(`[${m.role}] status=${m.status} tools=${JSON.stringify((m.toolEvents ?? []).map((t: { name: string; durationMs: number }) => `${t.name}(${t.durationMs}ms)`))}`);
  console.log(`   ${String(m.content ?? "").slice(0, 300)}`);
}
const sess = await db.collection("fill_agent_sessions").findOne({ _id: new ObjectId(SID) });
console.log("\nsession:", JSON.stringify({ status: sess?.status, fieldmap: sess?.fieldmap?.length, analysis: sess?.analysis ? Object.keys(sess.analysis) : null, openQ: sess?.openQuestions?.length }));
await c.close();
