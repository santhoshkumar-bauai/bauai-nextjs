import { ObjectId } from "mongodb";

import type { CompanyContext } from "../../company/context.ts";
import { getObjectBuffer } from "../../storage/s3.ts";
import { CitationCollector } from "../agent/citations.ts";
import type { AgentRunContext } from "../agent/context.ts";
import { TenderRefCollector } from "../agent/tender-refs.ts";
import { UiCallCollector } from "../agent/ui-calls.ts";
import { forCompanyContext } from "../tenant/repository.ts";
import type { FillGrounding } from "../dora/fill/grounding.ts";
import {
  getSandboxClient,
  SandboxRequestError,
  type SandboxAnalyzeResult,
  type SandboxClient,
} from "./sandbox-client.ts";
import {
  getFillSession,
  updateFillSession,
  type FillAgentSessionDocument,
} from "./store.ts";

/**
 * The fill agent's run context: Clara's AgentRunContext (tender: null — this
 * agent has no tender surface) plus the fill session and the sandbox. Built
 * SERVER-SIDE from the authenticated request; tools close over it and never
 * take tenant/session ids as inputs.
 *
 * `ensureSandbox()` is what makes the ephemeral sidecar workspace safe to
 * lose: it is always reconstructible from S3 (source bytes) + Mongo (fieldmap
 * and values), both deterministic. Any tool touching the sandbox calls it
 * first and gets a live workspace id.
 */
export interface FillAgentRunContext extends AgentRunContext {
  session: FillAgentSessionDocument;
  sandbox: SandboxClient;
  /** Latest sidecar analyze result for this run, if it ran. */
  analyzeResult: SandboxAnalyzeResult | null;
  /** Server-only cache populated by the explicit company-context graph node. */
  companyGrounding: FillGrounding | null | undefined;
  ensureSandbox(): Promise<string>;
  /** Re-read the session after a store update so tools see fresh budgets. */
  reloadSession(): Promise<FillAgentSessionDocument>;
}

export async function buildFillAgentRunContext(input: {
  companyContext: CompanyContext;
  sessionIdHex: string;
  locale: "en" | "de";
}): Promise<FillAgentRunContext | null> {
  if (!ObjectId.isValid(input.sessionIdHex)) return null;
  const tenantId = forCompanyContext(input.companyContext).value;
  const sessionId = new ObjectId(input.sessionIdHex);
  const session = await getFillSession(tenantId, sessionId);
  if (!session) return null;

  const sandbox = getSandboxClient();

  const ctx: FillAgentRunContext = {
    tenantId,
    userId: input.companyContext.userId,
    locale: input.locale,
    companyContext: input.companyContext,
    citations: new CitationCollector(),
    tenderRefs: new TenderRefCollector(),
    uiCalls: new UiCallCollector(),
    tender: null,
    tenderCache: new Map(),
    session,
    sandbox,
    analyzeResult: null,
    companyGrounding: undefined,

    async reloadSession() {
      const fresh = await getFillSession(tenantId, sessionId);
      if (fresh) ctx.session = fresh;
      return ctx.session;
    },

    async ensureSandbox() {
      const existing = ctx.session.sandboxSessionId;
      if (existing) {
        try {
          await sandbox.listFiles(existing);
          return existing;
        } catch (error) {
          // 400/404 = the workspace was GC'd or the sidecar restarted —
          // rebuild below. Anything else (unreachable, 5xx) propagates.
          if (
            !(error instanceof SandboxRequestError) ||
            (error.status !== 404 && error.status !== 400)
          ) {
            throw error;
          }
        }
      }
      const workspaceId = await sandbox.createSession();
      const bytes = await getObjectBuffer(ctx.session.source.s3Key);
      await sandbox.uploadFile(workspaceId, "source.pdf", bytes);
      const analyze = await sandbox.runAnalyze(workspaceId);
      ctx.analyzeResult = analyze;
      const updated = await updateFillSession(tenantId, sessionId, {
        sandboxSessionId: workspaceId,
        ...(analyze.nativeFields ? { nativeFields: analyze.nativeFields } : {}),
      });
      if (updated) ctx.session = updated;
      return workspaceId;
    },
  };

  return ctx;
}
