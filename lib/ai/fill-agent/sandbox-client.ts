import { fillAgentEnv } from "./env.ts";
import type { FillIssue } from "./fieldmap.ts";

/**
 * Typed client for the fill-sandbox sidecar (docker/fill-sandbox). Mirrors its
 * HTTP surface one-to-one; see the sidecar README for the trust model. All
 * JSON bodies stay small — bytes move through the file endpoints.
 *
 * A connection failure throws SandboxUnavailableError so tools can degrade to
 * a message instead of crashing the turn.
 */

export class SandboxUnavailableError extends Error {
  constructor(cause: unknown) {
    super("fill-sandbox is unreachable — is it running? (npm run sandbox:fill)");
    this.name = "SandboxUnavailableError";
    this.cause = cause;
  }
}

export class SandboxRequestError extends Error {
  // Plain fields, not TS parameter properties — scripts run under Node's
  // strip-only type mode, which cannot erase constructor sugar.
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(`fill-sandbox request failed (${status}): ${detail}`);
    this.name = "SandboxRequestError";
    this.status = status;
    this.detail = detail;
  }
}

export interface SandboxExecResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  newFiles: string[];
}

export interface SandboxNativeField {
  field_id: string;
  kind: "text" | "button" | "choice" | "signature" | "unknown";
  label: string;
  current: string;
  readonly: boolean;
  page: number | null;
  box: [number, number, number, number] | null;
  on_value?: string;
  off_value?: string;
  options?: string[];
}

export interface SandboxAnalyzeResult {
  kind: "acroform" | "flattened" | "scanned";
  pageCount?: number;
  geometryFile?: string;
  pageImages?: string[];
  nativeFields?: SandboxNativeField[];
  emptyBoxCount?: number;
  dottedLineCount?: number;
}

export interface SandboxValidateResult {
  issues: FillIssue[];
  score: number;
  summary: string;
}

export interface SandboxCropPair {
  field_id: string | null;
  page: number;
  kind: string;
  label: string;
  path: string;
  ink_lost: number;
}

export interface SandboxFileInfo {
  name: string;
  sizeBytes: number;
  mtime: number;
}

export interface SandboxClient {
  health(): Promise<{ ok: boolean; toolkitVersion: string }>;
  createSession(): Promise<string>;
  deleteSession(sessionId: string): Promise<void>;
  uploadFile(
    sessionId: string,
    name: string,
    bytes: Buffer,
  ): Promise<{ name: string; sizeBytes: number; sha256: string }>;
  listFiles(sessionId: string): Promise<SandboxFileInfo[]>;
  downloadFile(sessionId: string, relPath: string): Promise<Buffer>;
  exec(sessionId: string, code: string, timeoutMs?: number): Promise<SandboxExecResult>;
  runAnalyze(sessionId: string, pdf?: string): Promise<SandboxAnalyzeResult>;
  runPrepare(
    sessionId: string,
    fieldmapFile?: string,
  ): Promise<{ fieldCount: number; styleGroups: number; preparedFile: string }>;
  runFill(
    sessionId: string,
  ): Promise<{ outputFile: string; pageImages: string[] }>;
  runValidate(sessionId: string): Promise<SandboxValidateResult>;
  runCrops(sessionId: string, issues: FillIssue[]): Promise<{ pairs: SandboxCropPair[] }>;
}

let testOverride: SandboxClient | null = null;

/** Test hook: inject a fake client; pass null to restore the real one. */
export function setSandboxClientForTests(client: SandboxClient | null): void {
  testOverride = client;
}

async function request(
  path: string,
  init: RequestInit & { raw?: boolean } = {},
): Promise<unknown> {
  const env = fillAgentEnv();
  let response: Response;
  try {
    response = await fetch(`${env.sandboxUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.sandboxToken}`,
        ...(init.body && !init.raw ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    throw new SandboxUnavailableError(error);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new SandboxRequestError(response.status, detail.slice(0, 500));
  }
  if (init.raw) return Buffer.from(await response.arrayBuffer());
  return response.json();
}

function realClient(): SandboxClient {
  return {
    async health() {
      return (await request("/healthz")) as { ok: boolean; toolkitVersion: string };
    },
    async createSession() {
      const body = (await request("/sessions", { method: "POST" })) as {
        sessionId: string;
      };
      return body.sessionId;
    },
    async deleteSession(sessionId) {
      await request(`/sessions/${sessionId}`, { method: "DELETE" });
    },
    async uploadFile(sessionId, name, bytes) {
      return (await request(`/sessions/${sessionId}/files/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: new Uint8Array(bytes),
        raw: false,
        headers: { "content-type": "application/octet-stream" },
      })) as { name: string; sizeBytes: number; sha256: string };
    },
    async listFiles(sessionId) {
      const body = (await request(`/sessions/${sessionId}/files`)) as {
        files: SandboxFileInfo[];
      };
      return body.files;
    },
    async downloadFile(sessionId, relPath) {
      return (await request(`/sessions/${sessionId}/files/${relPath}`, {
        raw: true,
      })) as Buffer;
    },
    async exec(sessionId, code, timeoutMs) {
      return (await request(`/sessions/${sessionId}/exec`, {
        method: "POST",
        body: JSON.stringify({ code, ...(timeoutMs ? { timeoutMs } : {}) }),
      })) as SandboxExecResult;
    },
    async runAnalyze(sessionId, pdf = "source.pdf") {
      return (await request(`/sessions/${sessionId}/run/analyze`, {
        method: "POST",
        body: JSON.stringify({ pdf }),
      })) as SandboxAnalyzeResult;
    },
    async runPrepare(sessionId, fieldmapFile = "fieldmap.json") {
      return (await request(`/sessions/${sessionId}/run/prepare`, {
        method: "POST",
        body: JSON.stringify({ fieldmapFile }),
      })) as { fieldCount: number; styleGroups: number; preparedFile: string };
    },
    async runFill(sessionId) {
      return (await request(`/sessions/${sessionId}/run/fill`, {
        method: "POST",
        body: JSON.stringify({}),
      })) as { outputFile: string; pageImages: string[] };
    },
    async runValidate(sessionId) {
      return (await request(`/sessions/${sessionId}/run/validate`, {
        method: "POST",
        body: JSON.stringify({}),
      })) as SandboxValidateResult;
    },
    async runCrops(sessionId, issues) {
      return (await request(`/sessions/${sessionId}/run/crops`, {
        method: "POST",
        body: JSON.stringify({ issues }),
      })) as { pairs: SandboxCropPair[] };
    },
  };
}

export function getSandboxClient(): SandboxClient {
  return testOverride ?? realClient();
}
