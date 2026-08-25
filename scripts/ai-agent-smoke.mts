/**
 * Agent model smoke test: one prompt through the chat-model factory.
 *
 *   npm run ai:agent:smoke
 *   npm run ai:agent:smoke -- --role report
 *
 * The role argument matters because roles no longer differ by MODEL — they
 * differ by reasoning effort and output budget, and a role misconfigured there
 * fails silently (an exhausted budget returns empty content, not an error).
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { getChatModel } = await import("../lib/ai/agent/model.ts");
const { resolveRole } = await import("../lib/ai/gateway/config.ts");
const { roleMaxOutputTokens, roleReasoningEffort } = await import("../lib/ai/config/env.ts");

const roleArg = process.argv.indexOf("--role");
const role = (roleArg > -1 ? process.argv[roleArg + 1] : "agent") as Parameters<
  typeof getChatModel
>[0] extends { role?: infer R }
  ? NonNullable<R>
  : never;

const ref = resolveRole(role);
console.log(
  `[agent-smoke] role "${role}" → ${ref.provider}:${ref.model} ` +
    `effort=${roleReasoningEffort(role) ?? "(provider default)"} ` +
    `maxOut=${roleMaxOutputTokens(role)}`,
);

const model = await getChatModel({ role });
const started = Date.now();
const reply = await model.invoke([
  ["system", "You are a terse assistant."],
  ["human", "In one sentence: what is a Leistungsverzeichnis in German public tenders?"],
]);

const { textFromContent } = await import("../lib/ai/agent/content.ts");
const text = textFromContent(reply.content);
console.log(`[agent-smoke] ${Date.now() - started}ms`);
// textFromContent, not reply.content: reasoning models return array content
// with the thinking mixed in, and reading it raw prints "[object Object]".
console.log(`[agent-smoke] reply: ${text || "(EMPTY — check the role's output budget)"}`);
const usage = (reply as { usage_metadata?: Record<string, unknown> }).usage_metadata;
if (usage) console.log(`[agent-smoke] tokens:`, JSON.stringify(usage));
if (!text) process.exit(1);
