import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { z } from "zod";

import { logger } from "../../ingestion/observability/logger.ts";
import { textFromContent } from "../agent/content.ts";
import { getChatModel } from "../agent/model.ts";
import { roleMaxOutputTokens, roleReasoningEffort } from "../config/env.ts";
import { resolveAzureDeployment, resolveRole } from "../gateway/config.ts";
import { buildFillGrounding } from "../dora/fill/grounding.ts";
import type { FillAgentRunContext } from "./context.ts";
import {
  critiqueResponseSchema,
  fillFieldmapResponseSchema,
  fillPatchSchema,
  summariseIssues,
  type FillField,
  type FillIssue,
  type FillPatch,
} from "./fieldmap.ts";
import { fillAgentEnv } from "./env.ts";
import {
  FILL_ABSOLUTE_RULES,
  FILL_CRITIQUE_PROMPT,
  FILL_PLAN_PROMPT,
  FILL_REPAIR_PROMPT,
} from "./prompts.ts";

/**
 * The three sub-model calls behind the fill tools — direct ports of the
 * Python POC's node_plan / node_critique / node_repair. They run INSIDE a
 * tool call (the shared tool loop's ToolMessages are text-only, so page
 * images could not ride back through the loop), each on its own tiered role:
 * plan → `fill_agent_plan` (sol), critique → `fill_agent_critique` (terra,
 * promoted to the plan tier on the final pre-escalation iteration), repair →
 * `fill_agent_repair` (luna). Every role falls back to `fill_agent` until
 * its tier's deployment exists.
 *
 * Trust boundary: everything returned here is validated by zod and then
 * post-processed by trusted code (sensitivity ratchet, patch merge). The
 * model proposes; it never writes state directly.
 */

const GEOMETRY_CHAR_CAP = 180_000;
const NATIVE_FIELDS_CHAR_CAP = 60_000;
const GROUNDING_CHAR_CAP = 40_000;
const REPAIR_PAYLOAD_CHAR_CAP = 150_000;
const MAX_CRITIQUE_PAGE_IMAGES = 12;
const MAX_REPAIR_PAGE_IMAGES = 6;

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

function imagePart(png: Buffer): ContentPart {
  return {
    type: "image_url",
    image_url: { url: `data:image/png;base64,${png.toString("base64")}` },
  };
}

/** Models wrap JSON in fences roughly a third of the time (ported hack). */
function jsonFrom(text: string): unknown {
  let t = text.trim();
  if (t.includes("```")) {
    t = t.split("```")[1] ?? t;
    if (t.startsWith("json")) t = t.slice(4);
  }
  return JSON.parse(t.trim());
}

/** The tiered planner roles; each falls back to `fill_agent` in the registry. */
type FillPlannerRole = "fill_agent_plan" | "fill_agent_critique" | "fill_agent_repair";

const log = logger.child("ai.fillagent.planner");

/** Routing metadata for the per-call log line. Best-effort: a broken role
 * resolution must surface on the model call, never on the log. */
function describeRouting(role: FillPlannerRole): Record<string, unknown> {
  try {
    const ref = resolveRole(role);
    return {
      role,
      provider: ref.provider,
      model: ref.model,
      ...(ref.provider === "azure" ? { deployment: resolveAzureDeployment(ref.model) } : {}),
      effort: roleReasoningEffort(role),
      maxOutputTokens: roleMaxOutputTokens(role),
    };
  } catch {
    return { role };
  }
}

/** Invoke the fill model expecting JSON matching `schema`; one retry with the
 * parse error appended before giving up. */
async function invokeJson<T>(
  content: ContentPart[],
  schema: z.ZodType<T>,
  opts: { role: FillPlannerRole; escalated?: boolean },
): Promise<T> {
  // temperature is a no-op on the Azure branch (the reasoning deployment
  // rejects sampling params) but pins sampling the moment a fill role moves
  // to a provider that accepts it.
  const model = await getChatModel({ role: opts.role, temperature: 0 });
  const system = new SystemMessage(FILL_ABSOLUTE_RULES);
  const routing = describeRouting(opts.role);

  // These calls run INSIDE a tool call, so the graph's callback context
  // propagates in via AsyncLocalStorage — and the Gemini adapter emits
  // handleLLMNewToken even on its non-streaming path, so without a break the
  // raw fieldmap/critique JSON lands in on_chat_model_stream and runChatTurn
  // splices it into the user-visible assistant message. An explicit
  // `callbacks: []` REPLACES the inherited callbacks (ensureConfig's shallow
  // merge), keeping these inner calls out of the turn's token stream. Their
  // tokens therefore never reach turn metrics either — the structured
  // `planner_call` log line below is where this spend is visible.
  const attempt = async (parts: ContentPart[], retry: boolean): Promise<T> => {
    const startedAt = Date.now();
    const response = await model.invoke(
      [system, new HumanMessage({ content: parts as never })],
      { callbacks: [] },
    );
    const usage = (
      response as { usage_metadata?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } }
    ).usage_metadata;
    log.info("planner_call", {
      ...routing,
      durationMs: Date.now() - startedAt,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      totalTokens: usage?.total_tokens,
      retry,
      ...(opts.escalated ? { escalated: true } : {}),
    });
    const text = textFromContent(response.content);
    return schema.parse(jsonFrom(text));
  };

  try {
    return await attempt(content, false);
  } catch (error) {
    const note: ContentPart = {
      type: "text",
      text:
        "Your previous output was not valid JSON for the required shape " +
        `(${error instanceof Error ? error.message.slice(0, 300) : "parse error"}). ` +
        "Output raw JSON only — no prose, no fences.",
    };
    return attempt([...content, note], true);
  }
}

async function downloadJson(ctx: FillAgentRunContext, workspaceId: string, name: string) {
  const bytes = await ctx.sandbox.downloadFile(workspaceId, name);
  return JSON.parse(bytes.toString("utf-8"));
}

async function pageImageParts(
  ctx: FillAgentRunContext,
  workspaceId: string,
  dir: "source_pages" | "output_pages",
  pageNumbers: number[],
  cap: number,
): Promise<ContentPart[]> {
  const parts: ContentPart[] = [];
  for (const pageNo of pageNumbers.slice(0, cap)) {
    try {
      const png = await ctx.sandbox.downloadFile(workspaceId, `${dir}/page_${pageNo}.png`);
      parts.push({ type: "text", text: `--- ${dir === "source_pages" ? "rendered" : "filled"} page ${pageNo} ---` });
      parts.push(imagePart(png));
    } catch {
      // A missing render degrades that page to geometry-only — not fatal.
    }
  }
  return parts;
}

function slimGeometry(geometry: {
  pages: Array<Record<string, unknown>>;
}): string {
  const slim = geometry.pages.map((page) => ({
    page: page.page,
    width: page.width,
    height: page.height,
    empty_boxes: page.empty_boxes,
    checkboxes: page.checkboxes,
    dotted_lines: page.dotted_lines,
    rules: page.rules,
    words: page.words,
  }));
  return JSON.stringify(slim).slice(0, GEOMETRY_CHAR_CAP);
}

/** node_plan: geometry + page images + confirmed values → fieldmap. */
export async function proposeFieldmapWithModel(
  ctx: FillAgentRunContext,
  instructions?: string,
): Promise<FillField[]> {
  const workspaceId = await ctx.ensureSandbox();
  const geometry = await downloadJson(ctx, workspaceId, "geometry.json");
  const pageCount = ctx.session.pdf.pageCount;
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);

  const content: ContentPart[] = [{ type: "text", text: FILL_PLAN_PROMPT }];
  content.push(
    ...(await pageImageParts(
      ctx,
      workspaceId,
      "source_pages",
      pages,
      fillAgentEnv().maxPlanImages,
    )),
  );
  content.push({
    type: "text",
    text: `GEOMETRY (authoritative coordinates):\n${slimGeometry(geometry)}`,
  });
  if (ctx.session.nativeFields.length > 0) {
    content.push({
      type: "text",
      text:
        'NATIVE ACROFORM FIELDS (prefer these — set "target": "acroform" and use field_id as id):\n' +
        JSON.stringify(ctx.session.nativeFields).slice(0, NATIVE_FIELDS_CHAR_CAP),
    });
  }
  // Company grounding: the profile + a corpus slice, so the planner fills
  // what the company's own data answers instead of asking the user for it.
  // Degrades to conversation-only when the tenant has no profile yet.
  try {
    const grounding = await buildFillGrounding({
      tenantId: ctx.tenantId,
      tenderId: null,
    });
    const lines = [...grounding.profileLines, ...grounding.corpusLines];
    if (lines.length > 0) {
      content.push({
        type: "text",
        text:
          "COMPANY CONTEXT (grounded facts from the company profile and " +
          "documents — usable for values they clearly answer; never stretch " +
          "them to fields they do not):\n" +
          lines.join("\n").slice(0, GROUNDING_CHAR_CAP),
      });
    }
  } catch {
    // no company profile — the conversation collects everything
  }
  content.push({
    type: "text",
    text:
      `VALUES AVAILABLE (user-confirmed, keyed by field id):\n` +
      `${JSON.stringify(ctx.session.values)}\nMODE: real` +
      (instructions ? `\n\nADDITIONAL INSTRUCTIONS FROM THE CONVERSATION:\n${instructions.slice(0, 2000)}` : ""),
  });

  const parsed = await invokeJson(content, fillFieldmapResponseSchema, {
    role: "fill_agent_plan",
  });
  return parsed.fields;
}

/** node_critique: vision pass over filled pages + before/after crops.
 * ADD-ONLY — the caller merges, never replaces. On the final iteration
 * before the fill budget escalates, `escalate` promotes the critique to the
 * plan tier — the last chance to catch something before a human is involved. */
export async function critiqueFillWithModel(
  ctx: FillAgentRunContext,
  options?: { escalate?: boolean },
): Promise<FillIssue[]> {
  const workspaceId = await ctx.ensureSandbox();
  const pagesWithFields = [...new Set(ctx.session.fieldmap.map((f) => f.page))].sort(
    (a, b) => a - b,
  );

  const content: ContentPart[] = [{ type: "text", text: FILL_CRITIQUE_PROMPT }];
  content.push(
    ...(await pageImageParts(
      ctx,
      workspaceId,
      "output_pages",
      pagesWithFields,
      MAX_CRITIQUE_PAGE_IMAGES,
    )),
  );

  const { pairs } = await ctx.sandbox.runCrops(workspaceId, ctx.session.issues);
  if (pairs.length > 0) {
    content.push({
      type: "text",
      text: "--- close-up BEFORE (top) / AFTER (bottom) strips, 400dpi ---",
    });
  }
  for (const pair of pairs) {
    try {
      const png = await ctx.sandbox.downloadFile(workspaceId, pair.path);
      content.push({
        type: "text",
        text:
          `field=${pair.field_id} p${pair.page} kind=${pair.kind} ` +
          `label=${JSON.stringify(pair.label.slice(0, 60))} ink_lost=${pair.ink_lost}`,
      });
      content.push(imagePart(png));
    } catch {
      // skip unreadable crop
    }
  }

  const parsed = await invokeJson(content, critiqueResponseSchema, {
    role: options?.escalate ? "fill_agent_plan" : "fill_agent_critique",
    escalated: options?.escalate,
  });
  return parsed.issues;
}

/** node_repair: issues + fieldmap + broken-page images → a minimal PATCH. */
export async function repairFieldmapWithModel(
  ctx: FillAgentRunContext,
): Promise<FillPatch> {
  const workspaceId = await ctx.ensureSandbox();
  const payload = {
    issues: summariseIssues(ctx.session.issues, 40),
    fieldmap: ctx.session.fieldmap,
    iteration: ctx.session.fillIterations,
  };
  const content: ContentPart[] = [
    {
      type: "text",
      text: `${FILL_REPAIR_PROMPT}\n\n${JSON.stringify(payload).slice(0, REPAIR_PAYLOAD_CHAR_CAP)}`,
    },
  ];
  // Repair gets EYES: fixing a layout defect from an error string alone is
  // guesswork; seeing which edge is too far over makes it obvious.
  const brokenPages = [
    ...new Set(
      ctx.session.issues
        .filter((issue) => issue.severity === "error" && issue.page)
        .map((issue) => issue.page as number),
    ),
  ].sort((a, b) => a - b);
  content.push(
    ...(await pageImageParts(
      ctx,
      workspaceId,
      "output_pages",
      brokenPages,
      MAX_REPAIR_PAGE_IMAGES,
    )),
  );

  return invokeJson(content, fillPatchSchema, { role: "fill_agent_repair" });
}

/** Exposed for the smoke script: how many page images the planner may send. */
export function plannerImageBudget(): number {
  return Math.min(fillAgentEnv().maxPlanImages, fillAgentEnv().maxPages);
}
