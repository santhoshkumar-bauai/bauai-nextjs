import nextEnv from "@next/env";
nextEnv.loadEnvConfig(process.cwd());
const { MongoClient } = await import("mongodb");
const c = new MongoClient(process.env.MONGODB_URI!); await c.connect();
const db = c.db(process.env.MONGODB_DB || "bauai");
const thread = await db.collection("chat_threads").findOne({ threadKey: { $regex: "6a8e76e5870b016217432c18" } });
const before = await db.collection("chat_messages").countDocuments({ threadId: thread!._id });
for (let i = 0; i < 90; i++) {
  const msgs = await db.collection("chat_messages").find({ threadId: thread!._id }).sort({ _id: -1 }).limit(1).toArray();
  const last = msgs[0];
  if (last?.role === "assistant" && last.status !== "streaming" && (await db.collection("chat_messages").countDocuments({ threadId: thread!._id })) > before) {
    console.log(`status=${last.status}`);
    console.log("tools:", JSON.stringify((last.toolEvents ?? []).map((t: { name: string; durationMs: number }) => `${t.name}(${t.durationMs}ms)`)));
    console.log("content:", String(last.content ?? "").slice(0, 400));
    break;
  }
  await new Promise((r) => setTimeout(r, 4000));
}
await c.close();
