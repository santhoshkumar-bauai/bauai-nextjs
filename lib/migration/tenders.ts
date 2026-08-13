/**
 * Works out which tenders the migrated customers actually need.
 *
 * A full historical backfill would pull roughly half a million notices to serve
 * a few hundred saved ones, so this instead resolves the exact set the migrating
 * users reference — everything they saved, set aside, or put on a board — and
 * leaves the rest to normal live ingestion.
 *
 * Pure: the script does the I/O.
 */

export interface LegacyTenderRow {
  id: string;
  notice_id: string | null;
  contract_folder_id: string | null;
  publication_date: string | null;
  xml_url: string | null;
}

export interface TenderReference {
  /** Legacy tender uuid, as referenced by saved/disliked/workspace rows. */
  legacyTenderId: string;
  /** The source's own notice id — what `noticeRefs.sourceNoticeId` holds. */
  sourceNoticeId: string;
  /** eForms BT-04, which becomes `canonicalKey` as `proc:<id>`. */
  procedureId: string | null;
  publishedAt: Date | null;
  /** Legacy mirror of the notice XML, used when the source will not serve it. */
  fallbackXmlUrl: string | null;
}

/**
 * The per-notice endpoint. It is not in the source's published API docs — that
 * documents only the daily/monthly export archives — but it serves the same
 * eForms XML for a single notice and answers for both the uuid-style and
 * numeric notice ids present in the legacy data. Fetching ~340 notices this way
 * is far kinder to the source than re-downloading 142 day archives.
 */
export function noticeXmlUrl(sourceNoticeId: string): string {
  return `https://oeffentlichevergabe.de/api/notices/${encodeURIComponent(sourceNoticeId)}`;
}

/**
 * The human-facing notice page, identical to what the day-archive path records.
 * This is what ends up in `sourceLinks` and what a user clicks through to, so it
 * must not be the XML endpoint the migration happens to fetch from.
 */
export function noticeUiUrl(sourceNoticeId: string): string {
  return `https://oeffentlichevergabe.de/ui/de/bekanntmachung/${encodeURIComponent(sourceNoticeId)}`;
}

/** The canonical key the projection derives from an eForms procedure id. */
export function procedureCanonicalKey(procedureId: string): string {
  return `proc:${procedureId.toLowerCase()}`;
}

export function toTenderReference(row: LegacyTenderRow): TenderReference | null {
  const sourceNoticeId = row.notice_id?.trim();
  if (!sourceNoticeId) return null;

  const publishedAt = row.publication_date ? new Date(row.publication_date) : null;

  return {
    legacyTenderId: row.id,
    sourceNoticeId,
    procedureId: row.contract_folder_id?.trim() || null,
    publishedAt:
      publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
    fallbackXmlUrl: row.xml_url?.trim() || null,
  };
}

/** Dedupes references that several users or companies saved independently. */
export function dedupeReferences(
  references: TenderReference[],
): TenderReference[] {
  const byNoticeId = new Map<string, TenderReference>();
  for (const reference of references) {
    const existing = byNoticeId.get(reference.sourceNoticeId);
    // Prefer the row that carries a procedure id — it gives the canonical key
    // a second way to match an already-ingested tender.
    if (!existing || (!existing.procedureId && reference.procedureId)) {
      byNoticeId.set(reference.sourceNoticeId, reference);
    }
  }
  return [...byNoticeId.values()];
}
