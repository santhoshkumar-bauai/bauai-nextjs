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
import { ADAPTIVE_PDF_SKILL } from "./adaptive-pdf-skill.ts";
import type { SandboxCropPair } from "./sandbox-client.ts";
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

// Geometry/native/repair caps live in fillAgentEnv() — they scale with the
// supported page range. Grounding does not grow with pages, so it stays here.
const GROUNDING_CHAR_CAP = 40_000;
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
  const system = new SystemMessage(
    `${FILL_ABSOLUTE_RULES}\n\nLOADED SKILL (${ADAPTIVE_PDF_SKILL.name} v${ADAPTIVE_PDF_SKILL.version}):\n` +
      ADAPTIVE_PDF_SKILL.instructions,
  );
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
  //
  // Transport failures (429 quota, timeout, content filter) are NOT retried
  // here — resending an identical payload to a rate-limited deployment just
  // 429s again, and the SDK's internal Retry-After waits already consumed the
  // per-attempt deadline. Throwing turns the failure into a ToolMessage the
  // agent can read out, instead of an empty 300s-aborted turn. Only PARSE
  // failures retry, with the error appended.
  const call = async (parts: ContentPart[], retry: boolean): Promise<string> => {
    const startedAt = Date.now();
    try {
      const response = await model.invoke(
        [system, new HumanMessage({ content: parts as never })],
        {
          callbacks: [],
          signal: AbortSignal.timeout(fillAgentEnv().plannerCallTimeoutMs),
        },
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
      return textFromContent(response.content);
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 300) : String(error);
      log.error("planner_call_failed", {
        ...routing,
        durationMs: Date.now() - startedAt,
        retry,
        error: detail,
      });
      throw new Error(
        `The ${opts.role} model call failed (${detail}). ` +
          "If this is a rate limit, the deployment's quota is too small for this payload — tell the user rather than retrying.",
      );
    }
  };

  try {
    return schema.parse(jsonFrom(await call(content, false)));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`The ${opts.role} model call failed`)) {
      throw error; // transport — do not resend the payload
    }
    const note: ContentPart = {
      type: "text",
      text:
        "Your previous output was not valid JSON for the required shape " +
        `(${error instanceof Error ? error.message.slice(0, 300) : "parse error"}). ` +
        "Output raw JSON only — no prose, no fences.",
    };
    return schema.parse(jsonFrom(await call([...content, note], true)));
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
}, pageNumbers?: ReadonlySet<number>): string {
  const slim = geometry.pages
    .filter((page) => !pageNumbers || pageNumbers.has(Number(page.page)))
    .map((page) => ({
    page: page.page,
    width: page.width,
    height: page.height,
    empty_boxes: page.empty_boxes,
    checkboxes: page.checkboxes,
    dotted_lines: page.dotted_lines,
    placeholder_lines: page.placeholder_lines,
    entry_lines: page.entry_lines,
    cells: page.cells,
    rules: page.rules,
    words: page.words,
  }));
  return JSON.stringify(slim).slice(0, fillAgentEnv().geometryCharCap);
}

async function proposeFieldmapPages(
  ctx: FillAgentRunContext,
  pages: number[],
  instructions?: string,
): Promise<FillField[]> {
  if (pages.length === 0 || pages.length > fillAgentEnv().maxPages) {
    throw new Error("Adaptive field mapping received an invalid document page range.");
  }
  const workspaceId = await ctx.ensureSandbox();
  const geometry = await downloadJson(ctx, workspaceId, "geometry.json");
  const pageSet = new Set(pages);

  const content: ContentPart[] = [{ type: "text", text: FILL_PLAN_PROMPT }];
  content.push(
    ...(await pageImageParts(
      ctx,
      workspaceId,
      "source_pages",
      pages,
      Math.min(pages.length, fillAgentEnv().maxPlanImages),
    )),
  );
  content.push({
    type: "text",
    text:
      `DOCUMENT PAGES IN THIS PLAN: ${pages.join(", ")}\n` +
      `COMPLETE DOCUMENT GEOMETRY AND TRUSTED ANCHORS:\n${slimGeometry(geometry, pageSet)}`,
  });
  const native = ctx.session.nativeFields.filter(
    (field) => field.page != null && pageSet.has(field.page),
  );
  if (native.length > 0) {
    content.push({
      type: "text",
      text:
        `NATIVE ACROFORM FIELDS:\n` +
        JSON.stringify(native).slice(0, fillAgentEnv().nativeFieldsCharCap),
    });
  }
  try {
    const grounding = await buildFillGrounding({ tenantId: ctx.tenantId, tenderId: null });
    const lines = [...grounding.profileLines, ...grounding.corpusLines];
    if (lines.length > 0) {
      content.push({
        type: "text",
        text: `COMPANY CONTEXT (evidence, never authorization for declarations):\n${lines.join("\n").slice(0, GROUNDING_CHAR_CAP)}`,
      });
    }
  } catch {
    // no grounding available
  }
  content.push({
    type: "text",
    text:
      `USER-CONFIRMED VALUES:\n${JSON.stringify(ctx.session.values)}\n` +
      `Map every fillable position on pages ${pages[0]}-${pages[pages.length - 1]} in this ONE document plan. ` +
      `Every overlay field must select an anchorId from COMPLETE DOCUMENT GEOMETRY; never emit a new coordinate.` +
      (instructions ? `\nADDITIONAL INSTRUCTIONS:\n${instructions.slice(0, 2000)}` : ""),
  });
  const parsed = await invokeJson(content, fillFieldmapResponseSchema, {
    role: "fill_agent_plan",
  });
  return parsed.fields.filter((field) => pageSet.has(field.page));
}

export async function proposeFieldmapBatchWithModel(
  ctx: FillAgentRunContext,
  pageStart: number,
  pageEnd: number,
  instructions?: string,
): Promise<FillField[]> {
  if (pageStart < 1 || pageEnd < pageStart || pageEnd - pageStart > 3) {
    throw new Error("Invalid four-page mapping batch.");
  }
  return proposeFieldmapPages(
    ctx,
    Array.from({ length: pageEnd - pageStart + 1 }, (_, index) => pageStart + index),
    instructions,
  );
}

/** node_plan: geometry + page images + confirmed values → fieldmap. */
export async function proposeFieldmapWithModel(
  ctx: FillAgentRunContext,
  instructions?: string,
): Promise<FillField[]> {
  const pageCount = ctx.session.pdf.pageCount;
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
  return proposeFieldmapPages(ctx, pages, instructions);
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
      text: `${FILL_REPAIR_PROMPT}\n\n${JSON.stringify(payload).slice(0, fillAgentEnv().repairPayloadCharCap)}`,
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

/** Repair one 400-DPI crop. The model sees no other pages or coordinates and
 * cannot touch fields outside the crop. */
export async function repairRegionWithModel(
  ctx: FillAgentRunContext,
  crop: SandboxCropPair,
  issues: FillIssue[],
): Promise<FillPatch> {
  const workspaceId = await ctx.ensureSandbox();
  const affectedIds = new Set(
    issues
      .filter((issue) => issue.field_id && (issue.page == null || issue.page === crop.page))
      .map((issue) => issue.field_id as string)
      .filter((id) => ctx.session.fieldmap.some((field) => field.id === id && field.page === crop.page)),
  );
  if (crop.field_id && ctx.session.fieldmap.some((field) => field.id === crop.field_id && field.page === crop.page)) {
    affectedIds.add(crop.field_id);
  }
  const affectedFields = ctx.session.fieldmap.filter(
    (field) => field.page === crop.page && affectedIds.has(field.id),
  );
  const localAnchorIds = new Set(crop.localAnchors.map((anchor) => anchor.anchorId));
  const image = await ctx.sandbox.downloadFile(workspaceId, crop.comparisonPath);
  const content: ContentPart[] = [
    {
      type: "text",
      text:
        `${ADAPTIVE_PDF_SKILL.instructions}\n\n${FILL_REPAIR_PROMPT}\n\nLOCAL REPAIR ONLY. ` +
        `Allowed field ids: ${JSON.stringify([...affectedIds])}. ` +
        `Allowed anchor ids: ${JSON.stringify([...localAnchorIds])}. ` +
        `Do not emit box coordinates. Select anchorId when geometry changes.\n` +
        JSON.stringify({
          crop: {
            page: crop.page,
            dpi: crop.dpi,
            cropBox: crop.cropBox,
            pixelSize: crop.pixelSize,
            measurements: crop.measurements,
          },
          issues,
          affectedFields,
          localAnchors: crop.localAnchors,
        }).slice(0, 80_000),
    },
    imagePart(image),
  ];
  const patch = await invokeJson(content, fillPatchSchema, { role: "fill_agent_repair" });

  assertLocalizedPatch(patch, crop.page, affectedIds, localAnchorIds);
  return patch;
}

export function assertLocalizedPatch(
  patch: FillPatch,
  cropPage: number,
  affectedIds: ReadonlySet<string>,
  localAnchorIds: ReadonlySet<string>,
): void {
  const outside = [
    ...patch.update.map((field) => field.id),
    ...patch.remove,
  ].filter((id) => !affectedIds.has(id));
  if (outside.length > 0 || patch.add.some((field) => field.page !== cropPage)) {
    throw new Error("Localized repair attempted to mutate a field outside its crop.");
  }
  for (const update of patch.update) {
    if (update.box) throw new Error("Localized repair emitted arbitrary coordinates.");
    if (update.anchorId && !localAnchorIds.has(update.anchorId)) {
      throw new Error("Localized repair selected an anchor outside its crop.");
    }
  }
  if (patch.add.length > 0) {
    throw new Error("Localized repairs may not add ungrounded fields; remap the batch instead.");
  }
}

/** Exposed for the smoke script: how many page images the planner may send. */
export function plannerImageBudget(): number {
  return Math.min(fillAgentEnv().maxPlanImages, fillAgentEnv().maxPages);
}
