import { NextResponse } from "next/server";
import { z } from "zod";

import { buildIrisRunContext } from "@/lib/ai/iris/context";
import { streamIrisTurn } from "@/lib/ai/iris/stream";
import type { IrisUIMessage } from "@/lib/ai/iris/wire";
import { aiRoleConfigured } from "@/lib/ai/gateway/config";
import { getCompanyContext } from "@/lib/company/context";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";

/**
 * Iris — the generative-UI agent POC. One turn, streamed in the Vercel AI SDK's
 * UI message format so the client can be a plain `useChat`.
 *
 * `getCompanyContext()` is the auth gate, same as every other agent surface: no
 * verified session and active membership means no agent, and the tenant it
 * resolves is the ONLY tenant scope the tools can see.
 */

/**
 * The body `useChat` posts. Parts are validated loosely on purpose: this is
 * client-owned conversation state that only ever becomes (a) prompt text and
 * (b) a `[rendered: …]` note, both of which the agent already treats as
 * untrusted. Tightening it to the full part union would reject a message the
 * SDK legitimately grew a new part type for, mid-conversation.
 */
const postSchema = z.object({
  id: z.string().max(120).optional(),
  messages: z
    .array(
      z.object({
        id: z.string().max(120),
        role: z.enum(["user", "assistant", "system"]),
        parts: z.array(z.object({ type: z.string() }).loose()).max(200),
        metadata: z.unknown().optional(),
      }),
    )
    .min(1)
    // The client sends the whole conversation every turn; the graph windows it
    // again before the model call, so this is a payload guard, not a context
    // budget.
    .max(80),
});

export async function POST(request: Request) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  if (!aiRoleConfigured("iris")) {
    return NextResponse.json({ error: "AI is not configured" }, { status: 503 });
  }

  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const ctx = buildIrisRunContext({
    companyContext: context,
    locale: resolveRequestLocale(request),
  });

  return streamIrisTurn({
    ctx,
    messages: parsed.data.messages as unknown as IrisUIMessage[],
    request,
  });
}
