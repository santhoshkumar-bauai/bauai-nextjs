/** Client-safe wire contracts for the adaptive PDF workflow. */

export type FillWorkflowStatus =
  | "queued"
  | "inspecting"
  | "mapping"
  | "awaiting_input"
  | "filling"
  | "repairing"
  | "assembling"
  | "completed"
  | "needs_review";

export type FillPageStrategy =
  | "acroform"
  | "digital"
  | "scanned"
  | "hybrid"
  | "xfa"
  | "unsupported";

export interface FillAnchor {
  anchorId: string;
  page: number;
  kind: "empty_box" | "entry_line" | "placeholder" | "cell" | "checkbox" | "radio";
  box: [number, number, number, number];
  replaceBox?: [number, number, number, number];
}

export type ValueEvidenceSource =
  | "user"
  | "company_profile"
  | "company_document"
  | "model_inference";

export interface ValueEvidence {
  fieldId: string;
  value: string;
  source: ValueEvidenceSource;
  sourceRef: string;
  confidence: number;
  authorized: boolean;
  recordedAt: string;
}

export interface CompanyContextSummary {
  status: "loaded" | "unavailable";
  profileFacts: number;
  documentChunks: number;
  documentNames: string[];
  loadedAt: string;
}

export interface DecisionGroup {
  id: string;
  label: string;
  fieldIds: string[];
  options: Array<{ fieldId: string; label: string }>;
  required: boolean;
  sensitive: boolean;
  selection: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
}

export interface FillCropRef {
  fieldId: string | null;
  page: number;
  dpi: number;
  cropBox: [number, number, number, number];
  pixelSize: { width: number; height: number };
  beforePath: string;
  afterPath: string;
  comparisonPath: string;
  /** Strip of where the value BELONGS — its printed label and the entry beside
   * it. Null when the label could not be located or the destination is already
   * inside the landed crop. Shown next to the landed strip so the panel
   * displays the same context the repair model was given. */
  targetComparisonPath?: string | null;
}

export type FillBatchStatus =
  | "pending"
  | "mapping"
  | "awaiting_input"
  | "filling"
  | "validating"
  | "repairing"
  | "validated"
  | "needs_review";

export interface FillBatchState {
  id: string;
  pageStart: number;
  pageEnd: number;
  status: FillBatchStatus;
  strategy: FillPageStrategy[];
  fieldMapVersion: number;
  score: number | null;
  issues: number;
  attemptsByRegion: Record<string, number>;
  outputFile: string | null;
  frozenAt: string | null;
}

export type FillActivityAction =
  | "inspect_document"
  | "classify_strategy"
  | "load_skill"
  | "load_company_context"
  | "map_document"
  | "ground_values"
  | "await_input"
  | "fill_document"
  | "validate_document"
  | "verify_placement"
  | "crop_issues"
  | "repair_region"
  | "fill_repair_batch"
  | "validate_repair_batch"
  | "freeze_batch"
  | "assemble_document"
  | "final_validate";

export interface FillActivityEvent {
  cursor: number;
  at: string;
  action: FillActivityAction;
  status: "started" | "completed" | "paused" | "failed";
  batchId: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  message: string;
  model?: { name: "gpt-5.6-sol"; effort: "high" };
  crop?: FillCropRef;
  anchorId?: string;
  patchSummary?: { updated: number; added: number; removed: number };
  score?: number;
  elapsedMs?: number;
  remainingIssues?: number;
  /** Safe structured result for the chat, never raw prompts or reasoning. */
  output?: {
    title: string;
    lines: string[];
  };
}

export interface FillWorkflowSnapshot {
  status: FillWorkflowStatus;
  /** Bumped for an explicit retry so LangGraph starts a fresh checkpoint thread. */
  runId: number;
  geometryVersion: number;
  skill: {
    name: string;
    version: string;
    sourceUrl: string;
  } | null;
  companyContext: CompanyContextSummary | null;
  batchSize: number;
  currentBatchId: string | null;
  batches: FillBatchState[];
  activityCursor: number;
  activity: FillActivityEvent[];
  activeCrop: FillCropRef | null;
  evidence: Record<string, ValueEvidence>;
  decisions: DecisionGroup[];
}

/**
 * Whether a workflow RUN currently owns the document: its nodes are the only
 * writers of the fieldmap, the sandbox workspace and the score.
 *
 * The chat agent and the workflow graph are two engines over one session and
 * ONE sandbox workspace — both upload `fieldmap.json` and produce `filled.pdf`.
 * Letting the chat's analyze→plan→fill→repair pipeline run against a live
 * workflow rewrites the canonical fieldmap under the graph and races it for
 * those files, so `buildFillAgentTools` refuses those tools while this is true.
 *
 * `queued` means no run was ever started — the ONLYOFFICE editor panel creates
 * fill sessions and never starts a workflow, so the chat agent keeps its own
 * pipeline there. The workflow route moves the status out of `queued`
 * SYNCHRONOUSLY before it returns, so there is no window in which a chat turn
 * can slip past this check into a run that is already starting.
 *
 * `completed`/`needs_review` are the hand-back states: the run is over and the
 * chat agent is the one that continues the work with the human.
 */
export function workflowOwnsDocument(
  workflow: FillWorkflowSnapshot | null | undefined,
): boolean {
  const status = workflow?.status;
  if (status == null) return false;
  return status !== "queued" && status !== "completed" && status !== "needs_review";
}

export function emptyFillWorkflow(): FillWorkflowSnapshot {
  return {
    status: "queued",
    runId: 1,
    geometryVersion: 2,
    skill: null,
    companyContext: null,
    batchSize: 4,
    currentBatchId: null,
    batches: [],
    activityCursor: 0,
    activity: [],
    activeCrop: null,
    evidence: {},
    decisions: [],
  };
}
