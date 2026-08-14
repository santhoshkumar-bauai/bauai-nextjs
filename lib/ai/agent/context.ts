import { ObjectId } from "mongodb";

import type { CompanyContext } from "../../company/context.ts";
import { mongoDatabase } from "../../db/mongodb.ts";
import type { TenderDocument } from "../../ingestion/types.ts";
import {
  serializeTenderDetail,
  type SerializedTenderDetail,
} from "../../tenders/detail.ts";
import { forCompanyContext } from "../tenant/repository.ts";
import { CitationCollector } from "./citations.ts";
import { TenderRefCollector } from "./tender-refs.ts";
import { UiCallCollector } from "./ui-calls.ts";

/**
 * Everything a Clara run needs, derived SERVER-SIDE from the authenticated
 * request. Tools close over this — their inputs never carry TENANT identifiers,
 * so a prompt-injected tool call cannot change company scope (§6.5).
 *
 * `tender` is null for global (dashboard) chats. In global mode tools MAY take
 * a tenderId input — tender data is a globally shared corpus (chunks,
 * overviews and extractions all live under tenantId:null), so a tenderId
 * crosses no tenant boundary — but every such call must go through
 * `getVisibleTender` to re-validate existence and visibility.
 */
export interface AgentTenderScope {
  tenderId: ObjectId;
  tenderDetail: SerializedTenderDetail;
}

export interface AgentRunContext {
  tenantId: ObjectId;
  userId: string;
  locale: "en" | "de";
  companyContext: CompanyContext;
  citations: CitationCollector;
  /** Tenders the turn's tools touched, rendered as cards under the answer. */
  tenderRefs: TenderRefCollector;
  /** Frontend actions the turn's tools requested; empty for Clara and Dora. */
  uiCalls: UiCallCollector;
  tender: AgentTenderScope | null;
  /** Per-run memo so an 8-iteration global run doesn't refetch one tender. */
  tenderCache: Map<string, AgentTenderScope | null>;
}

/** A run bound to one tender (tender chat, verdict pipeline). */
export interface TenderAgentRunContext extends AgentRunContext {
  tender: AgentTenderScope;
}

/** Load + visibility-check one tender; null for invalid/missing/hidden ids. */
export async function resolveVisibleTender(
  tenderIdHex: string,
): Promise<AgentTenderScope | null> {
  if (!ObjectId.isValid(tenderIdHex)) return null;
  const tenderId = new ObjectId(tenderIdHex);

  const doc = await mongoDatabase
    .collection<TenderDocument>("tenders")
    .findOne({ _id: tenderId });
  if (!doc || doc.isVisible === false) return null;

  return { tenderId, tenderDetail: serializeTenderDetail(doc) };
}

/** Memoized per-run variant — the entry point for tool-side tender inputs. */
export async function getVisibleTender(
  ctx: AgentRunContext,
  tenderIdHex: string,
): Promise<AgentTenderScope | null> {
  if (ctx.tenderCache.has(tenderIdHex)) return ctx.tenderCache.get(tenderIdHex)!;
  const scope = await resolveVisibleTender(tenderIdHex);
  ctx.tenderCache.set(tenderIdHex, scope);
  return scope;
}

export async function buildAgentRunContext(input: {
  companyContext: CompanyContext;
  tenderIdHex: string;
  locale: "en" | "de";
}): Promise<TenderAgentRunContext | null> {
  const tender = await resolveVisibleTender(input.tenderIdHex);
  if (!tender) return null;

  return {
    tenantId: forCompanyContext(input.companyContext).value,
    userId: input.companyContext.userId,
    locale: input.locale,
    companyContext: input.companyContext,
    citations: new CitationCollector(),
    tenderRefs: new TenderRefCollector(),
    uiCalls: new UiCallCollector(),
    tender,
    tenderCache: new Map([[input.tenderIdHex, tender]]),
  };
}

/** Dashboard chat: company scope only, tenders reached per-call via tools. */
export function buildGlobalAgentRunContext(input: {
  companyContext: CompanyContext;
  locale: "en" | "de";
}): AgentRunContext {
  return {
    tenantId: forCompanyContext(input.companyContext).value,
    userId: input.companyContext.userId,
    locale: input.locale,
    companyContext: input.companyContext,
    citations: new CitationCollector(),
    tenderRefs: new TenderRefCollector(),
    uiCalls: new UiCallCollector(),
    tender: null,
    tenderCache: new Map(),
  };
}
