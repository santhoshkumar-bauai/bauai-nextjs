/**
 * Agent model smoke test: one prompt through the chat-model factory.
 *
 *   npm run ai:agent:smoke
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { getAgentChatModel } = await import("../lib/ai/agent/model.ts");
const { resolveRole } = await import("../lib/ai/gateway/config.ts");

const ref = resolveRole("agent");
console.log(`[agent-smoke] role "agent" → ${ref.provider}:${ref.model}`);

const model = await getAgentChatModel();
const started = Date.now();
const reply = await model.invoke([
  ["system", "You are a terse assistant."],
  ["human", "In one sentence: what is a Leistungsverzeichnis in German public tenders?"],
]);

console.log(`[agent-smoke] ${Date.now() - started}ms`);
console.log(`[agent-smoke] reply: ${reply.content}`);
const usage = (reply as { usage_metadata?: Record<string, number> }).usage_metadata;
if (usage) console.log(`[agent-smoke] tokens:`, usage);
