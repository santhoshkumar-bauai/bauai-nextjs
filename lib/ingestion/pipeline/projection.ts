import { Decimal128, type ObjectId } from "mongodb";

import type {
  OutboxEventType,
  SourceNotice,
  TenderDocument,
  TenderNoticeRef,
  TenderStatus,
} from "../types.ts";
import { deriveStatusFromNotice, deriveVisibility, scoreDataQuality } from "./status.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The canonical key identifies a *procedure*, not a notice, so a contract notice
 * and its later award notice converge on one aggregate.
 *
 * Only strong official identifiers are used, as section 8.2 requires. The eForms
 * procedure identifier (BT-04) is the same value whether a procedure is published
 * nationally or on TED, so a globally unique one links the two sources
 * automatically. A procedure id that is only locally unique stays scoped to its
 * source, and a notice with no procedure id becomes its own aggregate — separate
 * records are always preferable to a false merge (§8.3).
 */
export function computeCanonicalKey(notice: SourceNotice): string {
  const procedureId = notice.source.procedureId?.trim();
  if (procedureId) {
    return UUID.test(procedureId)
      ? `proc:${procedureId.toLowerCase()}`
      : `proc:${notice.source.code}:${procedureId}`;
  }

  const publicationNumber = notice.source.publicationNumber?.trim();
  if (publicationNumber) return `ojs:${publicationNumber}`;

  return `notice:${notice.source.code}:${notice.source.noticeId}`;
}

export interface ProjectionResult {
  canonicalKey: string;
  /** Fields to write; `_id` and `firstSeenAt` are only set on insert. */
  document: Omit<TenderDocument, "_id">;
  eventType: OutboxEventType;
  statusChanged: boolean;
  /** True when the incoming version is older than the projected one. */
  staleVersion: boolean;
}

export interface ProjectionInput {
  notice: SourceNotice;
  noticeId: ObjectId;
  existing: TenderDocument | null;
  now: Date;
  /** Historical inserts must not raise user alerts unless still open (§9.4). */
  isBackfill: boolean;
}

/**
 * Builds the current application projection for a procedure.
 *
 * Section 8.3 rules applied here: keep every source reference, let the newest
 * valid notice win, and never let an award overwrite the opportunity's own title
 * and description — an award advances the same procedure's lifecycle rather than
 * replacing its history.
 */
export function projectTender(input: ProjectionInput): ProjectionResult {
  const { notice, noticeId, existing, now } = input;

  const canonicalKey = computeCanonicalKey(notice);
  const publishedAt = notice.publication.publishedAt;

  const incomingRef: TenderNoticeRef = {
    noticeId,
    source: notice.source.code,
    sourceNoticeId: notice.source.noticeId,
    versionKey: notice.source.versionKey,
    typeCode: notice.notice.typeCode,
    publishedAt,
  };

  const noticeRefs = mergeNoticeRefs(existing?.noticeRefs ?? [], incomingRef);

  // "Newest" is decided by source publication time, not arrival order, so a
  // reconciliation run replaying an older version cannot regress the projection.
  // `noticeRefs` is sorted ascending and the incoming ref is appended last among
  // equal timestamps, so `>=` makes a same-timestamp republication win — the safer
  // reading of an update that reuses its publication time.
  const newestRef = noticeRefs.reduce<TenderNoticeRef | null>((newest, ref) => {
    if (!newest) return ref;
    const candidate = ref.publishedAt?.getTime() ?? 0;
    const incumbent = newest.publishedAt?.getTime() ?? 0;
    return candidate >= incumbent ? ref : newest;
  }, null);

  // The incoming version is stale exactly when some other known version is newer.
  // This must not be decided against `existing.publicationDate`, which tracks the
  // procedure's *earliest* publication and would call a genuinely old replay current.
  const staleVersion =
    existing !== null && newestRef !== null && !sameRef(newestRef, incomingRef);

  const previousStatus: TenderStatus | null = existing?.status ?? null;

  /*
   * A stale version is recorded but must not shape the projection at all. Every
   * displayed field keeps its current value and only the additive collections grow:
   * the version joins `noticeRefs`, its source and related ids are merged, and the
   * classification vocabularies are unioned. Gating just the status here — as an
   * earlier revision of this function did — let an old replay overwrite the title,
   * which is exactly the regression section 8.3 warns about.
   */
  if (staleVersion && existing) {
    return {
      canonicalKey,
      document: {
        ...existing,
        cpvCodes: unionStrings(existing.cpvCodes, notice.snapshot.cpvCodes),
        countries: unionStrings(existing.countries, notice.snapshot.countries),
        regions: unionStrings(existing.regions, notice.snapshot.regions),
        noticeRefs,
        sourceLinks: mergeSourceLinks(existing.sourceLinks, notice),
        relatedNoticeIds: mergeRelated(
          existing.relatedNoticeIds,
          notice.snapshot.relatedNoticeIds,
        ),
        aggregateVersion: existing.aggregateVersion + 1,
        lastSeenAt: now,
        updatedAt: now,
      },
      // The aggregate did change — a new official version is attached to it — so an
      // event is still emitted; it simply reports no status transition.
      eventType: "TENDER_UPDATED",
      statusChanged: false,
      staleVersion: true,
    };
  }

  const status = deriveStatusFromNotice(notice, now);
  const isVisible = deriveVisibility(notice, status);
  const quality = scoreDataQuality(notice);

  // An award or modification notice contributes status and result data, but the
  // opportunity's own wording is kept when it already exists.
  const isLifecycleAdvance =
    existing !== null &&
    (notice.notice.businessCategory === "AWARD_RESULT" ||
      notice.notice.businessCategory === "CONTRACT_UPDATE" ||
      notice.notice.businessCategory === "COMPLETED_CONTRACT");

  const title = isLifecycleAdvance && existing.title
    ? existing.title
    : (notice.snapshot.title.original ?? existing?.title ?? null);
  const description = isLifecycleAdvance && existing.description
    ? existing.description
    : (notice.snapshot.description.original ?? existing?.description ?? null);

  const nextStatus = status;

  const document: Omit<TenderDocument, "_id"> = {
    canonicalKey,
    status: nextStatus,
    businessCategory: notice.notice.businessCategory,
    isVisible,
    title,
    description,
    language: notice.snapshot.title.language ?? existing?.language ?? null,
    buyer: preferNonEmpty(notice.snapshot.buyer, existing?.buyer ?? null),
    lots: notice.snapshot.lots.length ? notice.snapshot.lots : (existing?.lots ?? []),
    cpvCodes: unionStrings(existing?.cpvCodes, notice.snapshot.cpvCodes),
    countries: unionStrings(existing?.countries, notice.snapshot.countries),
    regions: unionStrings(existing?.regions, notice.snapshot.regions),
    estimatedValue: toDecimalMoney(notice.snapshot.value) ?? existing?.estimatedValue ?? null,
    procedureType: notice.snapshot.procedureType ?? existing?.procedureType ?? null,
    contractNature: notice.snapshot.contractNature ?? existing?.contractNature ?? null,
    // Publication date tracks the earliest official publication of the procedure,
    // which is what users expect to see as "published".
    publicationDate: earliest(existing?.publicationDate ?? null, publishedAt),
    submissionDeadline:
      notice.snapshot.submissionDeadline ?? existing?.submissionDeadline ?? null,
    documents: notice.snapshot.documents.length
      ? notice.snapshot.documents
      : (existing?.documents ?? []),
    currentNoticeId: noticeId,
    currentVersionKey: notice.source.versionKey,
    noticeRefs,
    sourceLinks: mergeSourceLinks(existing?.sourceLinks ?? [], notice),
    relatedNoticeIds: mergeRelated(
      existing?.relatedNoticeIds ?? [],
      notice.snapshot.relatedNoticeIds,
    ),
    dataQuality: quality,
    enrichment: existing?.enrichment ?? {
      geocoding: { status: "PENDING" },
      translation: { status: "PENDING" },
      embedding: { status: "PENDING" },
    },
    aggregateVersion: (existing?.aggregateVersion ?? 0) + 1,
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const eventType: OutboxEventType = !existing
    ? "TENDER_CREATED"
    : previousStatus !== nextStatus
      ? "TENDER_STATUS_CHANGED"
      : "TENDER_UPDATED";

  return {
    canonicalKey,
    document,
    eventType,
    statusChanged: previousStatus !== nextStatus,
    staleVersion,
  };
}

/**
 * Whether an event for this projection should reach user notifications. A
 * historical insert is silent unless it is still an open opportunity (§9.4).
 */
export function shouldSuppressNotifications(
  result: ProjectionResult,
  isBackfill: boolean,
): boolean {
  if (!isBackfill) return false;
  const openStatuses: TenderStatus[] = ["OPEN", "CLOSING_SOON", "UPCOMING"];
  return !openStatuses.includes(result.document.status);
}

/* -------------------------------------------------------------------------- */
/* Merge helpers                                                              */
/* -------------------------------------------------------------------------- */

function sameRef(a: TenderNoticeRef, b: TenderNoticeRef): boolean {
  return (
    a.source === b.source &&
    a.sourceNoticeId === b.sourceNoticeId &&
    a.versionKey === b.versionKey
  );
}

/** Every official version is retained; only exact repeats are collapsed. */
function mergeNoticeRefs(
  existing: TenderNoticeRef[],
  incoming: TenderNoticeRef,
): TenderNoticeRef[] {
  const merged = existing.filter((ref) => !sameRef(ref, incoming));
  merged.push(incoming);
  merged.sort((a, b) => (a.publishedAt?.getTime() ?? 0) - (b.publishedAt?.getTime() ?? 0));
  return merged;
}

function mergeSourceLinks(
  existing: TenderDocument["sourceLinks"],
  notice: SourceNotice,
): TenderDocument["sourceLinks"] {
  const merged = existing.filter(
    (link) => !(link.source === notice.source.code && link.url === notice.source.url),
  );
  merged.push({
    source: notice.source.code,
    url: notice.source.url,
    licence: notice.source.licence,
  });
  return merged;
}

function mergeRelated(
  existing: Array<{ scheme: string; value: string }>,
  incoming: Array<{ scheme: string; value: string }>,
): Array<{ scheme: string; value: string }> {
  const seen = new Set(existing.map((entry) => `${entry.scheme}:${entry.value}`));
  const merged = [...existing];
  for (const entry of incoming) {
    const key = `${entry.scheme}:${entry.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

function unionStrings(existing: string[] | undefined, incoming: string[]): string[] {
  return [...new Set([...(existing ?? []), ...incoming])];
}

/** Prefers the richer of two records rather than letting a sparse update erase data. */
function preferNonEmpty<T extends object | null>(incoming: T, existing: T): T {
  if (!incoming) return existing;
  if (!existing) return incoming;
  const score = (value: object) =>
    Object.values(value).filter((entry) => entry !== null && entry !== undefined).length;
  return score(incoming) >= score(existing) ? incoming : existing;
}

function earliest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

/** Money is stored as Decimal128 so rounding never touches a contract value (§6.6). */
function toDecimalMoney(
  value: { amount: number | null; currency: string | null } | null,
): { amount: Decimal128 | null; currency: string | null } | null {
  if (!value) return null;
  if (value.amount === null) {
    return value.currency ? { amount: null, currency: value.currency } : null;
  }
  return {
    amount: Decimal128.fromString(value.amount.toFixed(4)),
    currency: value.currency,
  };
}
