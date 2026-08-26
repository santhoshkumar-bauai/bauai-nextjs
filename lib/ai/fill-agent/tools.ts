import { createHash, randomUUID } from "node:crypto";

import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { buildObjectKey, putObjectBuffer } from "../../storage/s3.ts";
import { flattenCompanyProfile } from "../dora/fill/grounding.ts";
import { hybridRetrieveCompanyChunks } from "../retrieval/hybrid.ts";
import type { FillAgentRunContext } from "./context.ts";
import { fillAgentEnv } from "./env.ts";
import {
  applyFieldmapPatch,
  applySensitivityRatchet,
  computeOpenQuestions,
  fillFieldSchema,
  scoreIssues,
  summariseIssues,
  type FillField,
} from "./fieldmap.ts";
import {
  critiqueFillWithModel,
  proposeFieldmapWithModel,
  repairFieldmapWithModel,
} from "./planner.ts";
import { SandboxUnavailableError } from "./sandbox-client.ts";
import { updateFillSession } from "./store.ts";
import { applyUserFieldValues } from "./values.ts";
import { workflowOwnsDocument } from "./workflow-wire.ts";

/**
 * The fill agent's tool registry. Same invariants as Clara/Dora tools: every
 * tool closes over the server-built context, no tenant/session id is ever a
 * tool input, outputs are bounded JSON strings.
 *
 * The Python POC's graph maps onto these tools with its three invariants
 * intact and SERVER-enforced (not prompt-enforced):
 *  - the LLM never computes the score — only /run/validate's number is stored;
 *  - repair emits a patch merged in trusted code — never a re-plan;
 *  - critique is add-only, once per session, only after an error-free validate.
 * Budgets (fill rounds per session) live in Mongo, so a new chat turn cannot
 * reset them.
 */

const EXEC_OUTPUT_CAP = 16_000;
const MAX_LISTED_NATIVE_FIELDS = 150;
const MAX_LISTED_OPEN_QUESTIONS = 40;

function sessionObjectId(ctx: FillAgentRunContext) {
  return ctx.session._id!;
}

/** Uniform degradation: a dead sidecar becomes a message, not a crashed turn. */
async function withSandbox(run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SandboxUnavailableError) {
      return JSON.stringify({
        sandboxUnavailable: true,
        hint: "The fill sandbox service is not reachable. Tell the user to start it (npm run sandbox:fill) and stop — no fill work is possible until then.",
      });
    }
    throw error;
  }
}

/**
 * The document pipeline is single-writer. While a workflow run owns the
 * session (lib/ai/fill-agent/workflow-graph.ts), the chat agent's own
 * analyze→plan→fill→repair tools are refused: they rewrite the canonical
 * fieldmap the graph is mid-way through and race it for the ONE sandbox
 * workspace both sides write `fieldmap.json` and `filled.pdf` into. Running
 * them concurrently is what makes a workflow's analysis and the chat's
 * analysis contradict each other.
 *
 * Conversation, grounding and value collection stay open — those are the
 * handoff the graph's `await_input` node is parked waiting for.
 */
function buildWorkflowGuard(ctx: FillAgentRunContext) {
  return async (alternative: string): Promise<string | null> => {
    const session = await ctx.reloadSession();
    if (!workflowOwnsDocument(session.workflow)) return null;
    return JSON.stringify({
      refused: true,
      reason: "workflow_owns_document",
      workflowStatus: session.workflow!.status,
      hint: `The automated fill workflow is running this document (status: ${session.workflow!.status}) and owns the field map, the sandbox and the score. ${alternative} Never re-run your own analysis while it is active — tell the user what the workflow is doing instead; its steps stream into this chat.`,
    });
  };
}

async function persistFieldmap(
  ctx: FillAgentRunContext,
  fields: FillField[],
): Promise<{ heldBack: string[] }> {
  const { fields: ratcheted, heldBack } = applySensitivityRatchet(
    fields,
    new Set(Object.keys(ctx.session.values)),
  );
  const openQuestions = computeOpenQuestions(ratcheted);
  const updated = await updateFillSession(ctx.tenantId, sessionObjectId(ctx), {
    fieldmap: ratcheted,
    openQuestions,
    status: "in_progress",
  });
  if (updated) ctx.session = updated;
  return { heldBack };
}

export function buildFillAgentTools(
  ctx: FillAgentRunContext,
): StructuredToolInterface[] {
  const guardWorkflow = buildWorkflowGuard(ctx);

  const analyzePdf = tool(
    async () =>
      withSandbox(async () => {
        const blocked = await guardWorkflow(
          "It inspects and classifies the document itself; get_session_status reports what it found.",
        );
        if (blocked) return blocked;
        const workspaceId = await ctx.ensureSandbox();
        // ensureSandbox ran analyze on (re)build; re-run cheaply if this
        // workspace predates the current process and we hold no result.
        const analyze =
          ctx.analyzeResult ?? (await ctx.sandbox.runAnalyze(workspaceId));
        ctx.analyzeResult = analyze;
        if (analyze.kind === "scanned") {
          return JSON.stringify({
            escalate: true,
            reason: "scanned_pdf",
            hint: "Scanned PDFs have no extractable geometry. Tell the user this document cannot be filled automatically.",
          });
        }
        return JSON.stringify({
          kind: analyze.kind,
          pageCount: analyze.pageCount,
          emptyBoxCount: analyze.emptyBoxCount,
          dottedLineCount: analyze.dottedLineCount,
          nativeFields: (analyze.nativeFields ?? [])
            .slice(0, MAX_LISTED_NATIVE_FIELDS)
            .map((field) => ({
              id: field.field_id,
              kind: field.kind,
              label: field.label,
              page: field.page,
              readonly: field.readonly,
              ...(field.options ? { options: field.options } : {}),
            })),
          hint: "Call propose_fieldmap next to map entry positions to fields.",
        });
      }),
    {
      name: "analyze_pdf",
      description:
        "Analyze the session's PDF in the sandbox: classification (acroform/flattened/scanned), page count, native form fields, and how many empty entry boxes the geometry shows. Always the first step.",
      schema: z.object({}),
    },
  );

  const proposeFieldmap = tool(
    async ({ instructions }: { instructions?: string }) =>
      withSandbox(async () => {
        const blocked = await guardWorkflow(
          "Its map_document node maps the whole document; a second mapping would overwrite it mid-run.",
        );
        if (blocked) return blocked;
        const session = await ctx.reloadSession();
        // Server gate, not prompt trust: once a validate has scored a real
        // fieldmap, re-planning wholesale replaces correct work and the score
        // random-walks — repair is the only forward path. The empty-fieldmap
        // exception matters: a repair patch's `remove` can empty the map
        // while the stale score persists, and without it the session would
        // deadlock (propose refused here, fill refuses "no_fieldmap").
        if (session.score != null && session.fieldmap.length > 0) {
          return JSON.stringify({
            refused: true,
            reason: "replan_after_validate",
            hint: "A validated fieldmap exists. Use repair_fieldmap to fix issues — re-planning discards correct work.",
          });
        }
        const fields = await proposeFieldmapWithModel(ctx, instructions);
        const { heldBack } = await persistFieldmap(ctx, fields);
        const byPage: Record<string, number> = {};
        for (const field of ctx.session.fieldmap) {
          byPage[`p${field.page}`] = (byPage[`p${field.page}`] ?? 0) + 1;
        }
        return JSON.stringify({
          fieldCount: ctx.session.fieldmap.length,
          byPage,
          openQuestions: ctx.session.openQuestions.slice(0, MAX_LISTED_OPEN_QUESTIONS),
          sensitiveHeldBack: heldBack,
          hint:
            ctx.session.openQuestions.some((q) => q.reason === "missing_required")
              ? "Ask the user for the missing required values (one compact list), then set_field_values."
              : "No required values missing — you can proceed to fill_and_validate.",
        });
      }),
    {
      name: "propose_fieldmap",
      description:
        "Map the form: a planning model reads the page renders + exact geometry and produces the fieldmap (field per entry position, with values where known from the conversation). Use ONCE at the start — after a failed validation use repair_fieldmap instead.",
      schema: z.object({
        instructions: z
          .string()
          .max(2000)
          .optional()
          .describe(
            "Optional focus from the conversation, e.g. which sections matter or values the user described loosely.",
          ),
      }),
    },
  );

  const setFieldValues = tool(
    async ({ values }: { values: Array<{ fieldId: string; value: string }> }) => {
      await ctx.reloadSession();
      const { session, applied, unknown } = await applyUserFieldValues({
        tenantId: ctx.tenantId,
        session: ctx.session,
        values,
      });
      ctx.session = session;

      return JSON.stringify({
        applied,
        ...(unknown.length > 0
          ? {
              unknownFieldIds: unknown,
              note: "Unknown ids are stored and will be used by the next propose/repair; check the fieldmap ids via get_session_status.",
            }
          : {}),
        openQuestions: ctx.session.openQuestions.slice(0, MAX_LISTED_OPEN_QUESTIONS),
      });
    },
    {
      name: "set_field_values",
      description:
        "Record values the USER stated in this conversation, by field id. Pass values RAW (unformatted — code applies German formatting via the field's value_type). Never call this with values the user did not provide.",
      schema: z.object({
        values: z
          .array(
            z.object({
              fieldId: z.string().min(1).max(80),
              value: z.string().max(2000),
            }),
          )
          .min(1)
          .max(60),
      }),
    },
  );

  const fillAndValidate = tool(
    async () =>
      withSandbox(async () => {
        const blocked = await guardWorkflow(
          "Its fill_document and validate_document nodes produce and score the PDF; a second fill would overwrite filled.pdf under them.",
        );
        if (blocked) return blocked;
        const session = await ctx.reloadSession();
        if (session.fieldmap.length === 0) {
          return JSON.stringify({
            refused: true,
            reason: "no_fieldmap",
            hint: "Call propose_fieldmap first.",
          });
        }
        if (session.fillIterations >= session.maxFillIterations) {
          await updateFillSession(ctx.tenantId, sessionObjectId(ctx), {
            status: "escalated",
          });
          return JSON.stringify({
            escalate: true,
            reason: "fill_budget_exhausted",
            iterations: session.fillIterations,
            hint: "The per-session fill budget is spent. Summarize the remaining issues for human review; do not retry.",
          });
        }
        const requiredOpen = session.openQuestions.filter(
          (q) => q.reason === "missing_required",
        );
        if (requiredOpen.length > 0) {
          return JSON.stringify({
            refused: true,
            reason: "open_required_questions",
            openQuestions: requiredOpen.slice(0, MAX_LISTED_OPEN_QUESTIONS),
            hint: "Ask the user for these values first, then set_field_values.",
          });
        }

        const workspaceId = await ctx.ensureSandbox();
        await ctx.sandbox.uploadFile(
          workspaceId,
          "fieldmap.json",
          Buffer.from(JSON.stringify({ fields: session.fieldmap })),
        );
        // prepare ALWAYS re-runs before fill — the repair→prepare edge from
        // the Python graph, so formatting/styling reflects the latest patch.
        await ctx.sandbox.runPrepare(workspaceId);
        await ctx.sandbox.runFill(workspaceId);
        const result = await ctx.sandbox.runValidate(workspaceId);

        const iteration = session.fillIterations + 1;
        const reachedTarget = result.score >= session.targetScore;
        const errors = result.issues.filter((i) => i.severity === "error").length;
        const warnings = result.issues.filter((i) => i.severity === "warning").length;

        let output: (typeof session)["output"] = session.output;
        if (reachedTarget) {
          const bytes = await ctx.sandbox.downloadFile(workspaceId, "filled.pdf");
          const key = buildObjectKey({
            companyId: String(ctx.companyContext.company._id),
            category: "fill-agent-poc",
            fileName: `filled-${session.source.fileName}`,
            uniqueId: randomUUID(),
          });
          await putObjectBuffer(key, bytes, "application/pdf");
          output = {
            s3Key: key,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            score: result.score,
            verifiedAt: new Date(),
          };
        }

        const updated = await updateFillSession(ctx.tenantId, sessionObjectId(ctx), {
          fillIterations: iteration,
          // A fresh validate re-arms the repair budget (2 rounds per validate).
          repairsSinceValidate: 0,
          issues: result.issues,
          score: result.score,
          status: reachedTarget ? "filled" : "in_progress",
          ...(output ? { output } : {}),
        });
        if (updated) ctx.session = updated;

        return JSON.stringify({
          score: result.score,
          targetScore: session.targetScore,
          iteration,
          iterationsRemaining: session.maxFillIterations - iteration,
          errors,
          warnings,
          summary: result.summary.slice(0, 4000),
          ...(reachedTarget
            ? {
                done: true,
                downloadReady: true,
                hint: "Target reached — the filled PDF is stored and downloadable in the panel. Optionally run critique_fill once for a visual pass before telling the user it is finished.",
              }
            : {
                hint:
                  errors > 0
                    ? "Errors gate the score to 0. Call repair_fieldmap, then fill_and_validate again; keep looping until the layout converges."
                    : "No errors — warnings are advisory. critique_fill can add a visual check, or repair_fieldmap can address the warnings.",
              }),
        });
      }),
    {
      name: "fill_and_validate",
      description:
        "The deterministic gate: format values (German locale), draw the fill, re-extract the produced PDF and score it (errors = hard 0). Counts against the per-session fill budget. On reaching the target score the filled PDF is stored for download.",
      schema: z.object({}),
    },
  );

  const critiqueFill = tool(
    async () =>
      withSandbox(async () => {
        const blocked = await guardWorkflow(
          "Its final_validate node scores the assembled document; wait for the run to finish before adding a visual pass.",
        );
        if (blocked) return blocked;
        const session = await ctx.reloadSession();
        if (session.critiqued) {
          return JSON.stringify({
            refused: true,
            reason: "critique_already_done",
            hint: "The visual critique runs once per session.",
          });
        }
        if (session.score == null) {
          return JSON.stringify({
            refused: true,
            reason: "critique_requires_validate",
            hint: "Run fill_and_validate first.",
          });
        }
        if (session.issues.some((issue) => issue.severity === "error")) {
          return JSON.stringify({
            refused: true,
            reason: "critique_requires_clean_validate",
            hint: "Deterministic errors must be repaired before the visual pass — repair_fieldmap.",
          });
        }

        // On the final allowed fill iteration the critique is promoted to the
        // plan tier — the last chance to catch a defect before a human is
        // involved. (`>=` rather than `===` survives an off-by-one; states
        // beyond the budget are unreachable — the fill gate escalates first.)
        const escalate = session.fillIterations >= session.maxFillIterations - 1;
        const added = await critiqueFillWithModel(ctx, { escalate });
        // Add-only merge: the critic can raise issues, never clear them —
        // it cannot be talked into approving a hard failure.
        const issues = [...session.issues, ...added];
        const score = scoreIssues(issues);
        const updated = await updateFillSession(ctx.tenantId, sessionObjectId(ctx), {
          critiqued: true,
          issues,
          score,
        });
        if (updated) ctx.session = updated;

        return JSON.stringify({
          addedIssues: added,
          score,
          ...(escalate ? { escalated: true } : {}),
          hint:
            added.length === 0
              ? "Visually clean. You can tell the user the fill is finished."
              : "The critique found visual issues — repair_fieldmap, then fill_and_validate.",
        });
      }),
    {
      name: "critique_fill",
      description:
        "One-time visual pass: a vision model inspects the filled pages plus 400dpi before/after crops for defects coordinates cannot catch (overlaps, misplacements, clipped template text). Only allowed after an error-free fill_and_validate; it can ADD issues, never clear them.",
      schema: z.object({}),
    },
  );

  const repairFieldmap = tool(
    async () =>
      withSandbox(async () => {
        const blocked = await guardWorkflow(
          "Its crop_issues → repair_region loop is already repairing the failing regions from local 400-DPI crops.",
        );
        if (blocked) return blocked;
        const session = await ctx.reloadSession();
        if (session.issues.length === 0) {
          return JSON.stringify({
            refused: true,
            reason: "nothing_to_repair",
            hint: "There are no recorded issues. Run fill_and_validate first.",
          });
        }
        // Anti-oscillation counter, re-armed by each fill_and_validate: the
        // loop may run as long as it needs, but repairs must round-trip
        // through the deterministic gate instead of stacking blind.
        const maxRepairs = fillAgentEnv().repairRounds;
        const repairs = session.repairsSinceValidate ?? 0;
        if (repairs >= maxRepairs) {
          return JSON.stringify({
            refused: true,
            reason: "repair_budget_exhausted",
            hint: `${maxRepairs} repair rounds since the last validate. Run fill_and_validate to re-score, or summarize the remaining issues for the user.`,
          });
        }
        const patch = await repairFieldmapWithModel(ctx);
        const merged = applyFieldmapPatch(session.fieldmap, patch);
        const parsed = z.array(fillFieldSchema).safeParse(merged);
        if (!parsed.success) {
          return JSON.stringify({
            refused: true,
            reason: "invalid_patch",
            detail: parsed.error.issues[0]?.message ?? "schema violation",
          });
        }
        await persistFieldmap(ctx, parsed.data);
        const updated = await updateFillSession(ctx.tenantId, sessionObjectId(ctx), {
          repairsSinceValidate: repairs + 1,
        });
        if (updated) ctx.session = updated;
        return JSON.stringify({
          updated: patch.update.length,
          added: patch.add.length,
          removed: patch.remove.length,
          repairsRemaining: maxRepairs - repairs - 1,
          issuesAddressed: summariseIssues(session.issues, 10),
          hint: "Now call fill_and_validate to re-score.",
        });
      }),
    {
      name: "repair_fieldmap",
      description:
        "Fix the recorded validation/critique issues: a repair model emits a minimal PATCH (update/add/remove) against the current fieldmap — never a rewrite. Follow with fill_and_validate.",
      schema: z.object({}),
    },
  );

  const runPython = tool(
    async ({ code, timeoutMs }: { code: string; timeoutMs?: number }) =>
      withSandbox(async () => {
        // Gated too: exec writes into the same workspace the graph's prepare /
        // fill / crop steps read, so an "observation only" script can still
        // clobber fieldmap.json or filled.pdf mid-run.
        const blocked = await guardWorkflow(
          "The sandbox workspace is being written by the run; inspecting it now would read half-written artifacts.",
        );
        if (blocked) return blocked;
        const workspaceId = await ctx.ensureSandbox();
        const result = await ctx.sandbox.exec(workspaceId, code, timeoutMs);
        return JSON.stringify({
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stdout: result.stdout.slice(0, EXEC_OUTPUT_CAP),
          stderr: result.stderr.slice(0, EXEC_OUTPUT_CAP),
          durationMs: result.durationMs,
          newFiles: result.newFiles.slice(0, 50),
          note: "Observation only — this never validates a fill. The deliverable always comes from fill_and_validate.",
        });
      }),
    {
      name: "run_python",
      description:
        "Execute Python in the session's sandbox workspace for INSPECTION and EXPERIMENTATION (source.pdf and all artifacts are in the working directory; pdfplumber/pypdf/reportlab and `toolkit` are importable; no network). Its output proves nothing about fill quality — the deliverable always comes from fill_and_validate.",
      schema: z.object({
        code: z.string().min(1).max(20_000),
        timeoutMs: z.number().int().min(1000).max(60_000).optional(),
      }),
    },
  );

  const getCompanyProfile = tool(
    async () => {
      const { Company } = await import("../../../models/company.ts");
      const { connectMongoose } = await import("../../db/mongoose.ts");
      await connectMongoose();
      const company = await Company.findById(ctx.tenantId).lean();
      if (!company) return JSON.stringify({ empty: true });
      const lines = [...flattenCompanyProfile(company).entries()]
        .slice(0, 120)
        .map(([key, value]) => `${key}: ${value.slice(0, 200)}`);
      return JSON.stringify({ profile: lines });
    },
    {
      name: "get_company_profile",
      description:
        "The company's structured profile (name, legal form, address, registration, contacts, key figures) as key/value lines. Check here FIRST for form values before asking the user.",
      schema: z.object({}),
    },
  );

  const searchCompanyData = tool(
    async ({ query, k }: { query: string; k: number }) => {
      const hits = await hybridRetrieveCompanyChunks({
        text: query,
        k,
        filters: { tenantId: ctx.tenantId },
      });
      return JSON.stringify({
        hits: hits.map((hit) => ({
          fileName: hit.fileName,
          text: hit.text.slice(0, 1200),
        })),
        ...(hits.length === 0
          ? { hint: "Nothing grounded — ask the user for this value instead." }
          : {}),
      });
    },
    {
      name: "search_company_data",
      description:
        "Semantic search over the company's uploaded documents (references, certificates, financials). Use to ground a missing form value (e.g. 'Umsatz 2025', 'Handelsregisternummer') before asking the user. Values found here should be mentioned to the user so they can correct them.",
      schema: z.object({
        query: z.string().min(2).max(300),
        k: z.number().int().min(1).max(8).default(5),
      }),
    },
  );

  const renderPreview = tool(
    async () =>
      withSandbox(async () => {
        const workspaceId = await ctx.ensureSandbox();
        const files = await ctx.sandbox.listFiles(workspaceId);
        const names = files.map((file) => file.name);
        return JSON.stringify({
          sourcePages: names.filter((name) => name.startsWith("source_pages/")),
          outputPages: names.filter((name) => name.startsWith("output_pages/")),
          crops: names.filter((name) => name.startsWith("crops/")),
          note: "The panel's preview shows these renders; point the user at specific pages by number.",
        });
      }),
    {
      name: "render_preview",
      description:
        "List the rendered page images (source and filled) available to the user's preview panel — use it to tell the user which page to look at.",
      schema: z.object({}),
    },
  );

  const getSessionStatus = tool(
    async () => {
      const session = await ctx.reloadSession();
      const workflow = session.workflow;
      return JSON.stringify({
        status: session.status,
        // The workflow's own view of the document — what to summarize for the
        // user instead of re-deriving it with the (refused) pipeline tools.
        workflow: workflow
          ? {
              status: workflow.status,
              ownsDocument: workflowOwnsDocument(workflow),
              pageCount: session.pdf.pageCount,
              currentBatchId: workflow.currentBatchId,
              batches: workflow.batches.length,
              companyContext: workflow.companyContext?.status ?? null,
              recentSteps: workflow.activity.slice(-6).map((event) => ({
                action: event.action,
                status: event.status,
                message: event.message,
              })),
            }
          : null,
        fieldCount: session.fieldmap.length,
        fieldIds: session.fieldmap.slice(0, 100).map((field) => field.id),
        openQuestions: session.openQuestions.slice(0, MAX_LISTED_OPEN_QUESTIONS),
        fillIterations: session.fillIterations,
        maxFillIterations: session.maxFillIterations,
        repairsSinceValidate: session.repairsSinceValidate ?? 0,
        maxRepairsPerValidate: fillAgentEnv().repairRounds,
        score: session.score,
        targetScore: session.targetScore,
        critiqued: session.critiqued,
        downloadReady: session.output != null,
        issueCounts: {
          errors: session.issues.filter((i) => i.severity === "error").length,
          warnings: session.issues.filter((i) => i.severity === "warning").length,
        },
      });
    },
    {
      name: "get_session_status",
      description:
        "The session's server-held state: fieldmap size and ids, open questions, fill budget used, score, whether the download is ready. Use to re-ground after a long conversation.",
      schema: z.object({}),
    },
  );

  return [
    analyzePdf,
    proposeFieldmap,
    setFieldValues,
    fillAndValidate,
    critiqueFill,
    repairFieldmap,
    runPython,
    getCompanyProfile,
    searchCompanyData,
    renderPreview,
    getSessionStatus,
  ];
}
