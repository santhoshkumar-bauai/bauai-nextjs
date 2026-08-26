import { createHash, randomUUID } from "node:crypto";

import { END, START, StateGraph, interrupt, Command } from "@langchain/langgraph";

import { buildObjectKey, putObjectBuffer } from "../../storage/s3.ts";
import { getClaraCheckpointer } from "../agent/checkpointer.ts";
import { buildFillGrounding } from "../dora/fill/grounding.ts";
import type { FillAgentRunContext } from "./context.ts";
import {
  applyFieldmapPatch,
  applySensitivityRatchet,
  computeOpenQuestions,
  type FillField,
  type FillIssue,
} from "./fieldmap.ts";
import { ADAPTIVE_PDF_SKILL } from "./adaptive-pdf-skill.ts";
import { proposeFieldmapWithModel, repairRegionWithModel } from "./planner.ts";
import { updateFillSession } from "./store.ts";
import { FillWorkflowState, type FillWorkflowStateType } from "./workflow-state.ts";
import {
  emptyFillWorkflow,
  type DecisionGroup,
  type FillActivityAction,
  type FillActivityEvent,
  type FillBatchState,
  type FillCropRef,
  type FillWorkflowSnapshot,
  type FillWorkflowStatus,
  type ValueEvidence,
} from "./workflow-wire.ts";

const REPAIR_BATCH_SIZE = 4;
const MAX_REGION_ATTEMPTS = 3;
const DECLARATION_RE = /ausschluss|bescheinigung|datenbank|insolven|fehlverhalten|interessen.konflikt|sanktion|erkl.rung|ja\b|nein\b/i;
const SIGNATURE_RE = /unterschrift|signature|signatur/i;

function workflowThreadId(ctx: FillAgentRunContext): string {
  return `fillworkflow:${ctx.tenantId}:${ctx.session._id}:${ctx.session.workflow?.runId ?? 0}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Create repair batches only after full-document validation finds issues. */
export function repairBatchesForIssues(
  pageCount: number,
  strategies: FillWorkflowStateType["pageStrategies"],
  issues: FillIssue[],
): FillBatchState[] {
  const starts = new Set<number>();
  for (const issue of issues) {
    if (issue.severity !== "error" || issue.page == null) continue;
    const page = Math.max(1, Math.min(pageCount, issue.page));
    starts.add(Math.floor((page - 1) / REPAIR_BATCH_SIZE) * REPAIR_BATCH_SIZE + 1);
  }
  const batches: FillBatchState[] = [];
  for (const pageStart of [...starts].sort((a, b) => a - b)) {
    const pageEnd = Math.min(pageCount, pageStart + REPAIR_BATCH_SIZE - 1);
    batches.push({
      id: `repair-pages-${pageStart}-${pageEnd}`,
      pageStart,
      pageEnd,
      status: "pending",
      strategy: [...new Set(strategies.slice(pageStart - 1, pageEnd))],
      fieldMapVersion: 0,
      score: null,
      issues: 0,
      attemptsByRegion: {},
      outputFile: null,
      frozenAt: null,
    });
  }
  return batches;
}

function currentBatch(state: FillWorkflowStateType): FillBatchState {
  const batch = state.batches[state.currentBatchIndex];
  if (!batch) throw new Error("Fill workflow has no current batch.");
  return batch;
}

function withBatch(
  state: FillWorkflowStateType,
  patch: Partial<FillBatchState>,
): FillBatchState[] {
  return state.batches.map((batch, index) =>
    index === state.currentBatchIndex ? { ...batch, ...patch } : batch,
  );
}

async function persist(
  ctx: FillAgentRunContext,
  state: FillWorkflowStateType,
  patch: Partial<FillWorkflowSnapshot>,
  event?: Omit<FillActivityEvent, "cursor" | "at">,
): Promise<{ workflow: FillWorkflowSnapshot; activity: FillActivityEvent[] }> {
  const fresh = await ctx.reloadSession();
  const previous = fresh.workflow ?? emptyFillWorkflow();
  // The state passed to a long-running node is stale while the browser polls.
  // Always append to durable activity, otherwise a node's completion event can
  // accidentally overwrite its already-visible started event.
  let activity = patch.activity ?? previous.activity;
  let activityCursor = previous.activityCursor;
  if (event) {
    activityCursor += 1;
    activity = [...activity, { ...event, cursor: activityCursor, at: nowIso() }].slice(-500);
  }
  const workflow: FillWorkflowSnapshot = {
    ...previous,
    ...patch,
    activity,
    activityCursor,
  };
  const updated = await updateFillSession(ctx.tenantId, fresh._id!, { workflow });
  if (updated) ctx.session = updated;
  return { workflow, activity };
}

function eventFor(
  state: FillWorkflowStateType,
  action: FillActivityAction,
  status: FillActivityEvent["status"],
  message: string,
  extra: Partial<FillActivityEvent> = {},
): Omit<FillActivityEvent, "cursor" | "at"> {
  const batch = state.batches[state.currentBatchIndex];
  return {
    action,
    status,
    batchId: batch?.id ?? null,
    pageStart: batch?.pageStart ?? null,
    pageEnd: batch?.pageEnd ?? null,
    message,
    ...extra,
  };
}

export function buildDecisionGroups(
  fields: FillField[],
  previous: DecisionGroup[],
): DecisionGroup[] {
  const prior = new Map(previous.map((group) => [group.id, group]));
  const grouped = new Map<string, FillField[]>();
  for (const field of fields) {
    if (field.kind !== "checkbox") continue;
    const legal = DECLARATION_RE.test(`${field.id} ${field.label}`);
    if (!field.exclusive_group && !legal) continue;
    const baseId = field.id.replace(/(?:_?ja|_?nein|_?yes|_?no)$/i, "");
    const id = field.exclusive_group || `decision:${field.page}:${baseId}`;
    grouped.set(id, [...(grouped.get(id) ?? []), field]);
  }
  return [...grouped].map(([id, members]) => {
    const old = prior.get(id);
    return {
      id,
      label: members.map((field) => field.label).find(Boolean) || id,
      fieldIds: members.map((field) => field.id),
      options: members.map((field) => ({ fieldId: field.id, label: field.label || field.id })),
      required: members.some((field) => field.required) || members.some((field) => DECLARATION_RE.test(`${field.id} ${field.label}`)),
      sensitive: members.some((field) => DECLARATION_RE.test(`${field.id} ${field.label}`)),
      selection: old?.selection ?? null,
      confirmedBy: old?.confirmedBy ?? null,
      confirmedAt: old?.confirmedAt ?? null,
    };
  });
}

function normalizedLabel(value: string): string {
  return value.toLocaleLowerCase("de").replace(/[^a-z0-9äöüß]+/g, " ").trim();
}

export function retainExistingValues(
  mapped: FillField[],
  existing: FillField[],
  values: Record<string, string>,
): { fields: FillField[]; values: Record<string, string> } {
  const remappedValues = { ...values };
  const byId = new Map(existing.map((field) => [field.id, field]));
  const fields = mapped.map((field) => {
    let old = byId.get(field.id);
    if (!old) {
      const label = normalizedLabel(field.label);
      old = existing.find((candidate) =>
        candidate.page === field.page && label.length > 2 && normalizedLabel(candidate.label) === label,
      );
    }
    if (!old) {
      const center = (field.box[1] + field.box[3]) / 2;
      old = existing.find((candidate) =>
        candidate.page === field.page && Math.abs(((candidate.box[1] + candidate.box[3]) / 2) - center) <= 8,
      );
    }
    if (!old || (old.value == null && values[old.id] == null)) return field;
    const value = values[old.id] ?? String(old.value ?? "");
    if (Object.hasOwn(values, old.id)) remappedValues[field.id] = value;
    return { ...field, value };
  });
  return { fields, values: remappedValues };
}

async function groundBatchValues(
  ctx: FillAgentRunContext,
  fields: FillField[],
  existing: Record<string, ValueEvidence>,
): Promise<{ fields: FillField[]; evidence: Record<string, ValueEvidence> }> {
  const evidence = { ...existing };
  let grounding = ctx.companyGrounding;
  try {
    if (grounding === undefined) {
      grounding = await buildFillGrounding({ tenantId: ctx.tenantId, tenderId: null });
      ctx.companyGrounding = grounding;
    }
  } catch {
    grounding = null;
    ctx.companyGrounding = null;
  }
  const grounded = fields.map((field) => {
    const raw = field.value == null ? "" : String(field.value).trim();
    if (!raw || SIGNATURE_RE.test(`${field.id} ${field.label}`)) {
      return { ...field, value: "" };
    }
    let item: ValueEvidence;
    if (Object.hasOwn(ctx.session.values, field.id) && ctx.session.values[field.id] === raw) {
      item = { fieldId: field.id, value: raw, source: "user", sourceRef: `fill_session:${ctx.session._id}`,
        confidence: 1, authorized: true, recordedAt: nowIso() };
    } else if (grounding) {
      const companyHit = [...grounding.evidence.entries()].find(([, candidate]) =>
        candidate.source === "company_profile" && candidate.excerpt.trim() === raw,
      );
      const documentHit = companyHit ? undefined : [...grounding.evidence.entries()].find(([, candidate]) =>
        candidate.source === "company_document" && candidate.excerpt.includes(raw),
      );
      if (companyHit) {
        item = { fieldId: field.id, value: raw, source: "company_profile", sourceRef: companyHit[0],
        confidence: 0.98, authorized: true, recordedAt: nowIso() };
      } else if (documentHit) {
        item = { fieldId: field.id, value: raw, source: "company_document", sourceRef: documentHit[0],
          confidence: 0.9, authorized: true, recordedAt: nowIso() };
      } else {
        item = { fieldId: field.id, value: raw, source: "model_inference", sourceRef: "document_mapper",
          confidence: 0.5, authorized: false, recordedAt: nowIso() };
      }
    } else {
      item = { fieldId: field.id, value: raw, source: "model_inference", sourceRef: "document_mapper",
        confidence: 0.5, authorized: false, recordedAt: nowIso() };
    }
    evidence[field.id] = item;
    return item.authorized ? field : { ...field, value: "" };
  });
  return { fields: grounded, evidence };
}

export async function buildFillWorkflowGraph(ctx: FillAgentRunContext) {
  const inspectDocument = async (state: FillWorkflowStateType) => {
    const started = Date.now();
    await persist(
      ctx,
      state,
      { status: "inspecting", currentBatchId: null, batches: [] },
      eventFor(state, "inspect_document", "started", "Inspecting the complete document", {
        pageStart: 1,
        pageEnd: ctx.session.pdf.pageCount,
      }),
    );
    const workspaceId = await ctx.ensureSandbox();
    const analyze = ctx.analyzeResult ?? (await ctx.sandbox.runAnalyze(workspaceId));
    const pageStrategies = Array.from(
      { length: ctx.session.pdf.pageCount },
      (_, index) => analyze.pageStrategies?.find((item) => item.page === index + 1)?.strategy ?? analyze.kind,
    );
    const { activity } = await persist(
      ctx,
      state,
      { status: "inspecting", batches: [], currentBatchId: null },
      eventFor(state, "inspect_document", "completed", `Inspected ${ctx.session.pdf.pageCount} pages`, {
        elapsedMs: Date.now() - started, pageStart: 1, pageEnd: ctx.session.pdf.pageCount,
      }),
    );
    return { status: "inspecting" as const, pageStrategies, batches: [], activity };
  };

  const classifyStrategy = async (state: FillWorkflowStateType) => {
    const unsupported = state.pageStrategies.some((strategy) => strategy === "unsupported" || strategy === "xfa");
    const status: FillWorkflowStatus = unsupported ? "needs_review" : "mapping";
    const { activity } = await persist(
      ctx,
      state,
      { status },
      eventFor(state, "classify_strategy", unsupported ? "paused" : "completed",
        unsupported ? "XFA or damaged pages require human review" : "Selected per-page fill strategies"),
    );
    return { status, activity };
  };

  const loadSkill = async (state: FillWorkflowStateType) => {
    const skill = {
      name: ADAPTIVE_PDF_SKILL.name,
      version: ADAPTIVE_PDF_SKILL.version,
      sourceUrl: ADAPTIVE_PDF_SKILL.sourceUrl,
    };
    const { activity } = await persist(
      ctx,
      state,
      { status: "mapping", skill },
      eventFor(state, "load_skill", "completed", "Loaded the adaptive PDF filling skill"),
    );
    return { status: "mapping" as const, activity };
  };

  const loadCompanyContext = async (state: FillWorkflowStateType) => {
    const started = Date.now();
    await persist(
      ctx,
      state,
      { status: "mapping" },
      eventFor(state, "load_company_context", "started", "Loading company profile and company documents"),
    );
    try {
      const grounding = await buildFillGrounding({ tenantId: ctx.tenantId, tenderId: null });
      ctx.companyGrounding = grounding;
      const companyContext = {
        status: "loaded" as const,
        profileFacts: grounding.profileLines.length,
        documentChunks: grounding.corpusLines.length,
        documentNames: grounding.companyDocumentNames.slice(0, 12),
        loadedAt: nowIso(),
      };
      const lines = [
        `${companyContext.profileFacts} structured profile facts`,
        `${companyContext.documentChunks} indexed company-document sections`,
        companyContext.documentNames.length > 0
          ? `Documents: ${companyContext.documentNames.join(", ")}`
          : "No indexed company documents were needed or available",
      ];
      const { activity } = await persist(
        ctx,
        state,
        { status: "mapping", companyContext },
        eventFor(state, "load_company_context", "completed", "Loaded company context", {
          elapsedMs: Date.now() - started,
          output: { title: "Company context", lines },
        }),
      );
      return { activity };
    } catch {
      ctx.companyGrounding = null;
      const companyContext = {
        status: "unavailable" as const,
        profileFacts: 0,
        documentChunks: 0,
        documentNames: [],
        loadedAt: nowIso(),
      };
      const { activity } = await persist(
        ctx,
        state,
        { status: "mapping", companyContext },
        eventFor(state, "load_company_context", "completed", "Company context unavailable; continuing without it", {
          elapsedMs: Date.now() - started,
          output: {
            title: "Company context",
            lines: ["No company profile or indexed company-document evidence was available for this run"],
          },
        }),
      );
      return { activity };
    }
  };

  const mapDocument = async (state: FillWorkflowStateType) => {
    const started = Date.now();
    await persist(
      ctx,
      state,
      { status: "mapping" },
      eventFor(state, "map_document", "started", "Planning fields across the complete PDF", {
        pageStart: 1, pageEnd: ctx.session.pdf.pageCount,
        model: { name: "gpt-5.6-sol", effort: "high" },
      }),
    );
    const mapped = await proposeFieldmapWithModel(ctx);
    const retainedResult = retainExistingValues(mapped, ctx.session.fieldmap, ctx.session.values);
    if (JSON.stringify(retainedResult.values) !== JSON.stringify(ctx.session.values)) {
      const updated = await updateFillSession(ctx.tenantId, ctx.session._id!, { values: retainedResult.values });
      if (updated) ctx.session = updated;
    }
    const fieldmap = retainedResult.fields.sort((a, b) => a.page - b.page);
    const mappedPages = new Set(fieldmap.map((field) => field.page));
    const choiceFields = fieldmap.filter((field) => field.kind === "checkbox").length;
    const proposedValues = fieldmap.filter((field) => field.value != null && String(field.value).trim()).length;
    const requiredMissing = fieldmap.filter((field) =>
      field.required && (field.value == null || String(field.value).trim() === ""),
    ).length;
    const { activity } = await persist(
      ctx,
      state,
      { status: "mapping" },
      eventFor(state, "map_document", "completed", `Mapped ${fieldmap.length} fields across the complete PDF`, {
        pageStart: 1, pageEnd: ctx.session.pdf.pageCount,
        model: { name: "gpt-5.6-sol", effort: "high" },
        elapsedMs: Date.now() - started,
        output: {
          title: "Document plan",
          lines: [
            `${fieldmap.length} fill positions mapped across ${mappedPages.size} pages`,
            `${fieldmap.length - choiceFields} text/overlay fields · ${choiceFields} choice fields`,
            `${proposedValues} candidate values found before evidence verification`,
            `${requiredMissing} required fields still missing before grounding`,
          ],
        },
      }),
    );
    return { status: "mapping" as const, fieldmap, activity };
  };

  const groundValues = async (state: FillWorkflowStateType) => {
    const grounded = await groundBatchValues(ctx, state.fieldmap, state.evidence);
    let fieldmap = grounded.fields;
    const decisions = buildDecisionGroups(fieldmap, state.decisions);
    const decisionByField = new Map(
      decisions.flatMap((group) => group.fieldIds.map((fieldId) => [fieldId, group] as const)),
    );
    fieldmap = fieldmap.map((field) => {
      const group = decisionByField.get(field.id);
      if (!group) return field;
      return { ...field, value: group.selection === field.id ? "X" : "" };
    });
    const ratcheted = applySensitivityRatchet(fieldmap, new Set(Object.keys(ctx.session.values))).fields;
    const openQuestions = computeOpenQuestions(ratcheted);
    const updated = await updateFillSession(ctx.tenantId, ctx.session._id!, {
      fieldmap: ratcheted, openQuestions,
      workflow: { ...(ctx.session.workflow ?? emptyFillWorkflow()), evidence: grounded.evidence, decisions },
    });
    if (updated) ctx.session = updated;
    const { activity } = await persist(
      ctx,
      state,
      { evidence: grounded.evidence, decisions },
      eventFor(state, "ground_values", "completed", "Grounded values and recorded provenance", {
        output: (() => {
          const items = Object.values(grounded.evidence);
          const profileItems = items.filter((item) => item.authorized && item.source === "company_profile");
          const documentItems = items.filter((item) => item.authorized && item.source === "company_document");
          const userItems = items.filter((item) => item.authorized && item.source === "user");
          const labels = [...profileItems, ...documentItems]
            .map((item) => ratcheted.find((field) => field.id === item.fieldId)?.label || item.fieldId)
            .slice(0, 8);
          return {
            title: "Grounding result",
            lines: [
              `${profileItems.length} values authorized from the company profile`,
              `${documentItems.length} values authorized from company documents`,
              `${userItems.length} values retained from user input`,
              labels.length > 0 ? `Company-grounded fields: ${labels.join(", ")}` : "No fields matched company evidence",
            ],
          };
        })(),
      }),
    );
    return { fieldmap: ratcheted, evidence: grounded.evidence, decisions, openQuestions, activity };
  };

  const awaitInput = async (state: FillWorkflowStateType) => {
    const questions = state.openQuestions.filter((question) => question.reason === "missing_required");
    const decisions = state.decisions.filter((group) => group.required && !group.selection);
    if (questions.length === 0 && decisions.length === 0) return { status: "filling" as const };
    const freshBeforeInterrupt = await ctx.reloadSession();
    const alreadyPaused = freshBeforeInterrupt.workflow?.status === "awaiting_input";
    const activity = alreadyPaused
      ? freshBeforeInterrupt.workflow?.activity ?? state.activity
      : (await persist(
          ctx,
          state,
          { status: "awaiting_input" },
          eventFor(state, "await_input", "paused", `${questions.length} values and ${decisions.length} decisions need confirmation`),
        )).activity;
    interrupt({ type: "fill_workflow_input", scope: "document", questions, decisions });
    await ctx.reloadSession();
    const freshDecisions = ctx.session.workflow?.decisions ?? state.decisions;
    const unresolved = ctx.session.openQuestions.some((question) => question.reason === "missing_required") ||
      freshDecisions.some((group) => group.required && !group.selection);
    return {
      status: unresolved ? "awaiting_input" as const : "filling" as const,
      fieldmap: ctx.session.fieldmap,
      openQuestions: ctx.session.openQuestions,
      decisions: freshDecisions,
      activity,
    };
  };

  const fillDocument = async (state: FillWorkflowStateType) => {
    const started = Date.now();
    await persist(ctx, state, { status: "filling" },
      eventFor(state, "fill_document", "started", "Writing the complete PDF from the canonical field map", {
        pageStart: 1, pageEnd: ctx.session.pdf.pageCount,
      }));
    const workspaceId = await ctx.ensureSandbox();
    await ctx.sandbox.uploadFile(workspaceId, "fieldmap.json", Buffer.from(JSON.stringify({ fields: state.fieldmap })));
    await ctx.sandbox.runPrepare(workspaceId);
    await ctx.sandbox.runFill(workspaceId);
    const updated = await updateFillSession(ctx.tenantId, ctx.session._id!, {
      status: "in_progress",
      fillIterations: ctx.session.fillIterations + 1,
    });
    if (updated) ctx.session = updated;
    const { activity } = await persist(ctx, state, { status: "filling" },
      eventFor(state, "fill_document", "completed", "Filled the complete PDF", {
        pageStart: 1, pageEnd: ctx.session.pdf.pageCount, elapsedMs: Date.now() - started,
      }));
    return { status: "filling" as const, activity };
  };

  const validateDocument = async (state: FillWorkflowStateType) => {
    const started = Date.now();
    await persist(ctx, state, { status: "filling" },
      eventFor(state, "validate_document", "started", "Validating the complete filled PDF", {
        pageStart: 1, pageEnd: ctx.session.pdf.pageCount,
      }));
    const result = await ctx.sandbox.runValidate(await ctx.ensureSandbox());
    const errors = result.issues.filter((issue) => issue.severity === "error");
    const batches = repairBatchesForIssues(ctx.session.pdf.pageCount, state.pageStrategies, errors);
    const status: FillWorkflowStatus = errors.length === 0
      ? "assembling"
      : batches.length > 0 ? "repairing" : "needs_review";
    const updated = await updateFillSession(ctx.tenantId, ctx.session._id!, {
      issues: result.issues,
      score: result.score,
    });
    if (updated) ctx.session = updated;
    const { activity } = await persist(ctx, state, {
      status,
      batches,
      currentBatchId: batches[0]?.id ?? null,
    }, eventFor(state, "validate_document", "completed",
      errors.length === 0
        ? `Full-document score ${result.score.toFixed(2)}; no repair batches needed`
        : `Full-document score ${result.score.toFixed(2)}; planned ${batches.length} repair batches`, {
        pageStart: 1, pageEnd: ctx.session.pdf.pageCount,
        score: result.score, remainingIssues: result.issues.length, elapsedMs: Date.now() - started,
      }));
    return { status, issues: result.issues, batches, currentBatchIndex: 0, activity };
  };

  const cropIssues = async (state: FillWorkflowStateType) => {
    const batch = currentBatch(state);
    const localIssues = state.issues.filter((issue) =>
      issue.page != null && issue.page >= batch.pageStart && issue.page <= batch.pageEnd,
    );
    const workspaceId = await ctx.ensureSandbox();
    await persist(ctx, state, { status: "repairing" },
      eventFor(state, "crop_issues", "started", `Rendering local 400-DPI crops for ${batch.id}`));
    const result = await ctx.sandbox.runCrops(workspaceId, localIssues, batch.outputFile ?? "filled.pdf");
    const activeCrops: FillCropRef[] = result.pairs.map((pair) => ({
      fieldId: pair.field_id, page: pair.page, dpi: pair.dpi, cropBox: pair.cropBox,
      pixelSize: pair.pixelSize, beforePath: pair.beforePath, afterPath: pair.afterPath,
      comparisonPath: pair.comparisonPath,
    }));
    const { activity } = await persist(ctx, state, { status: "repairing", activeCrop: activeCrops[0] ?? null },
      eventFor(state, "crop_issues", "completed", `Rendered ${activeCrops.length} local 400-DPI comparisons`, {
        crop: activeCrops[0],
      }));
    return { status: "repairing" as const, activeCrops, activity };
  };

  const repairRegion = async (state: FillWorkflowStateType) => {
    const batch = currentBatch(state);
    const localBatchIssues = state.issues.filter((issue) =>
      issue.page != null && issue.page >= batch.pageStart && issue.page <= batch.pageEnd,
    );
    const pairs = await ctx.sandbox.runCrops(
      await ctx.ensureSandbox(), localBatchIssues, batch.outputFile ?? "filled.pdf",
    );
    const pair = pairs.pairs[0];
    if (!pair) return { batches: withBatch(state, { status: "needs_review" }) };
    const regionKey = `${pair.page}:${pair.field_id ?? "page"}`;
    const attempts = batch.attemptsByRegion[regionKey] ?? 0;
    if (attempts >= MAX_REGION_ATTEMPTS) {
      const batches = withBatch(state, { status: "needs_review" });
      await persist(ctx, state, { status: "repairing", batches },
        eventFor(state, "repair_region", "paused", "Region reached the three-attempt review limit"));
      return { status: "repairing" as const, batches };
    }
    const localIssues = state.issues.filter((issue) => issue.page === pair.page &&
      (!pair.field_id || issue.field_id === pair.field_id));
    await persist(ctx, state, { status: "repairing", activeCrop: state.activeCrops[0] ?? null },
      eventFor(state, "repair_region", "started", `Reviewing one crop on page ${pair.page}`, {
        model: { name: "gpt-5.6-sol", effort: "high" }, crop: state.activeCrops[0],
      }));
    const patch = await repairRegionWithModel(ctx, pair, localIssues);
    const fieldmap = applyFieldmapPatch(state.fieldmap, patch);
    const batches = withBatch(state, {
      status: "repairing",
      attemptsByRegion: { ...batch.attemptsByRegion, [regionKey]: attempts + 1 },
    });
    const updated = await updateFillSession(ctx.tenantId, ctx.session._id!, { fieldmap });
    if (updated) ctx.session = updated;
    const { activity } = await persist(ctx, state, { batches, activeCrop: null },
      eventFor(state, "repair_region", "completed", `Applied crop-local patch for ${regionKey}`, {
        model: { name: "gpt-5.6-sol", effort: "high" },
        anchorId: patch.update.find((item) => item.anchorId)?.anchorId,
        patchSummary: { updated: patch.update.length, added: 0, removed: patch.remove.length },
      }));
    return { fieldmap, batches, activeCrops: [], activity };
  };

  const fillRepairBatch = async (state: FillWorkflowStateType) => {
    const batch = currentBatch(state);
    const started = Date.now();
    await persist(ctx, state, { status: "repairing" },
      eventFor(state, "fill_repair_batch", "started", `Applying local fixes to pages ${batch.pageStart}-${batch.pageEnd}`));
    const workspaceId = await ctx.ensureSandbox();
    await ctx.sandbox.uploadFile(workspaceId, "fieldmap.json", Buffer.from(JSON.stringify({ fields: state.fieldmap })));
    await ctx.sandbox.runPrepare(workspaceId);
    const result = await ctx.sandbox.runFillBatch(workspaceId, batch.pageStart, batch.pageEnd);
    const batches = withBatch(state, { status: "validating", outputFile: result.outputFile });
    const { activity } = await persist(ctx, state, { status: "repairing", batches },
      eventFor(state, "fill_repair_batch", "completed", `Regenerated repair pages ${batch.pageStart}-${batch.pageEnd}`, {
        elapsedMs: Date.now() - started,
      }));
    return { batches, activity };
  };

  const validateRepairBatch = async (state: FillWorkflowStateType) => {
    const batch = currentBatch(state);
    const result = await ctx.sandbox.runValidateBatch(
      await ctx.ensureSandbox(), batch.pageStart, batch.pageEnd, batch.outputFile ?? undefined,
    );
    const errors = result.issues.filter((issue) => issue.severity === "error");
    const batches = withBatch(state, {
      score: result.score,
      issues: result.issues.length,
      status: errors.length === 0 ? "validated" : "repairing",
      ...(errors.length === 0 ? { frozenAt: nowIso() } : {}),
    });
    const unrelated = state.issues.filter((issue) =>
      issue.page == null || issue.page < batch.pageStart || issue.page > batch.pageEnd,
    );
    const issues = [...unrelated, ...result.issues];
    const { activity } = await persist(ctx, state, { batches },
      eventFor(state, "validate_repair_batch", "completed", `Repair batch score ${result.score.toFixed(2)}`, {
        score: result.score, remainingIssues: result.issues.length,
      }));
    return { issues, batches, activity };
  };

  const nextRepairBatch = async (state: FillWorkflowStateType) => {
    const nextIndex = state.currentBatchIndex + 1;
    const completed = currentBatch(state);
    if (nextIndex >= state.batches.length) {
      const { activity } = await persist(ctx, state, { status: "assembling", currentBatchId: null },
        eventFor(state, "freeze_batch", completed.status === "needs_review" ? "paused" : "completed",
          completed.status === "needs_review" ? `${completed.id} needs human review` : `Frozen ${completed.id}`));
      return { status: "assembling" as const, issues: [], activity };
    }
    const next = state.batches[nextIndex];
    const { activity } = await persist(ctx, state, { status: "repairing", currentBatchId: next.id },
      eventFor(state, "freeze_batch", completed.status === "needs_review" ? "paused" : "completed",
        `${completed.status === "needs_review" ? "Deferred" : "Frozen"} ${completed.id}; moving to ${next.id}`));
    return { status: "repairing" as const, currentBatchIndex: nextIndex, activity };
  };

  const assemble = async (state: FillWorkflowStateType) => {
    const started = Date.now();
    await persist(ctx, state, { status: "assembling", currentBatchId: null },
      eventFor(state, "assemble_document", "started", "Rebuilding the complete PDF from immutable source"));
    const workspaceId = await ctx.ensureSandbox();
    await ctx.sandbox.uploadFile(workspaceId, "fieldmap.json", Buffer.from(JSON.stringify({ fields: state.fieldmap })));
    await ctx.sandbox.runPrepare(workspaceId);
    await ctx.sandbox.runAssembleDocument(workspaceId);
    const { activity } = await persist(ctx, state, { status: "assembling", currentBatchId: null },
      eventFor(state, "assemble_document", "completed", "Rebuilt the document once from the immutable source", {
        elapsedMs: Date.now() - started,
      }));
    return { status: "assembling" as const, activity };
  };

  const finalValidate = async (state: FillWorkflowStateType) => {
    const started = Date.now();
    await persist(ctx, state, { status: "assembling" },
      eventFor(state, "final_validate", "started", "Running final full-document verification"));
    const workspaceId = await ctx.ensureSandbox();
    const result = await ctx.sandbox.runValidate(workspaceId);
    const passed = result.score >= ctx.session.targetScore && !result.issues.some((issue) => issue.severity === "error");
    let output = ctx.session.output;
    if (passed) {
      const bytes = await ctx.sandbox.downloadFile(workspaceId, "filled.pdf");
      const key = buildObjectKey({ companyId: String(ctx.companyContext.company._id),
        category: "fill-agent-poc", fileName: `filled-${ctx.session.source.fileName}`, uniqueId: randomUUID() });
      await putObjectBuffer(key, bytes, "application/pdf");
      output = { s3Key: key, sha256: createHash("sha256").update(bytes).digest("hex"),
        score: result.score, verifiedAt: new Date() };
    }
    const status: FillWorkflowStatus = passed ? "completed" : "needs_review";
    const { activity } = await persist(ctx, state, { status, activeCrop: null },
      eventFor(state, "final_validate", passed ? "completed" : "paused",
        passed ? "Final verification passed; download is ready" : "Final verification needs review", {
          score: result.score, remainingIssues: result.issues.length, elapsedMs: Date.now() - started,
        }));
    const updated = await updateFillSession(ctx.tenantId, ctx.session._id!, {
      fieldmap: state.fieldmap, issues: result.issues, score: result.score,
      status: passed ? "filled" : "escalated", ...(output ? { output } : {}),
    });
    if (updated) ctx.session = updated;
    return { status, issues: result.issues, activity };
  };

  return new StateGraph(FillWorkflowState)
    .addNode("inspect_document", inspectDocument)
    .addNode("classify_strategy", classifyStrategy)
    .addNode("load_skill", loadSkill)
    .addNode("load_company_context", loadCompanyContext)
    .addNode("map_document", mapDocument)
    .addNode("ground_values", groundValues)
    .addNode("await_input", awaitInput)
    .addNode("fill_document", fillDocument)
    .addNode("validate_document", validateDocument)
    .addNode("crop_issues", cropIssues)
    .addNode("repair_region", repairRegion)
    .addNode("fill_repair_batch", fillRepairBatch)
    .addNode("validate_repair_batch", validateRepairBatch)
    .addNode("next_repair_batch", nextRepairBatch)
    .addNode("assemble", assemble)
    .addNode("final_validate", finalValidate)
    .addEdge(START, "inspect_document")
    .addEdge("inspect_document", "classify_strategy")
    .addConditionalEdges("classify_strategy", (state) => state.status === "needs_review" ? "end" : "skill", { end: END, skill: "load_skill" })
    .addEdge("load_skill", "load_company_context")
    .addEdge("load_company_context", "map_document")
    .addEdge("map_document", "ground_values")
    .addEdge("ground_values", "await_input")
    .addConditionalEdges("await_input", (state) => state.status === "awaiting_input" ? "wait" : "fill", { wait: "await_input", fill: "fill_document" })
    .addEdge("fill_document", "validate_document")
    .addConditionalEdges("validate_document", (state) => state.status === "repairing" ? "repair" : state.status === "needs_review" ? "end" : "assemble", { repair: "crop_issues", assemble: "assemble", end: END })
    .addEdge("crop_issues", "repair_region")
    .addConditionalEdges("repair_region", (state) => currentBatch(state).status === "needs_review" ? "next" : "fill", { next: "next_repair_batch", fill: "fill_repair_batch" })
    .addEdge("fill_repair_batch", "validate_repair_batch")
    .addConditionalEdges("validate_repair_batch", (state) => currentBatch(state).status === "repairing" ? "repair" : "next", { repair: "crop_issues", next: "next_repair_batch" })
    .addConditionalEdges("next_repair_batch", (state) => state.status === "assembling" ? "assemble" : "repair", { assemble: "assemble", repair: "crop_issues" })
    .addEdge("assemble", "final_validate")
    .addEdge("final_validate", END)
    .compile({ checkpointer: await getClaraCheckpointer() });
}

export async function runFillWorkflow(
  ctx: FillAgentRunContext,
  resume?: unknown,
): Promise<void> {
  const graph = await buildFillWorkflowGraph(ctx);
  const config = { configurable: { thread_id: workflowThreadId(ctx) }, recursionLimit: 200 };
  if (resume !== undefined) {
    await graph.invoke(new Command({ resume }), config);
  } else {
    await graph.invoke({}, config);
  }
}
