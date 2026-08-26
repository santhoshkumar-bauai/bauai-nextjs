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
