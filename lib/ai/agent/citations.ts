/**
 * Per-turn citation collector. Tools register every quote/chunk they surface;
 * the finalized assistant message attaches the collected citations without
 * re-querying. Keys are stable within a turn (`c1`, `c2`, …) so the model can
 * reference them and the UI can render numbered chips.
 */

export interface ChatCitation {
  key: string;
  quote: string;
  fileName: string;
  documentRecordId: string | null;
  chunkId: string | null;
}

const QUOTE_CAP = 400;

export class CitationCollector {
  private readonly byIdentity = new Map<string, ChatCitation>();

  add(input: {
    quote: string;
    fileName: string;
    documentRecordId?: string | null;
    chunkId?: string | null;
  }): ChatCitation {
    const identity = `${input.chunkId ?? ""}:${input.quote.slice(0, 80)}`;
    const existing = this.byIdentity.get(identity);
    if (existing) return existing;

    const citation: ChatCitation = {
      key: `c${this.byIdentity.size + 1}`,
      quote:
        input.quote.length > QUOTE_CAP
          ? `${input.quote.slice(0, QUOTE_CAP)}…`
          : input.quote,
      fileName: input.fileName,
      documentRecordId: input.documentRecordId ?? null,
      chunkId: input.chunkId ?? null,
    };
    this.byIdentity.set(identity, citation);
    return citation;
  }

  list(): ChatCitation[] {
    return [...this.byIdentity.values()];
  }
}
