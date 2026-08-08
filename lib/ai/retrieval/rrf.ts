/**
 * Reciprocal-rank fusion (§17.3). Pure: takes ranked id lists, returns fused
 * scores. RRF is rank-based, so the incompatible score scales of Lucene BM25
 * and cosine similarity never need calibrating against each other.
 */

export interface RankedList {
  /** Ranked best-first. */
  ids: string[];
  /** Relative arm weight (default 1). */
  weight?: number;
}

export interface FusedEntry {
  id: string;
  score: number;
  /** 0-based rank per contributing arm, by arm index. */
  ranks: Array<number | null>;
}

export const RRF_K = 60;

export function fuseRanks(lists: RankedList[], k: number = RRF_K): FusedEntry[] {
  const scores = new Map<string, { score: number; ranks: Array<number | null> }>();

  lists.forEach((list, armIndex) => {
    const weight = list.weight ?? 1;
    list.ids.forEach((id, rank) => {
      let entry = scores.get(id);
      if (!entry) {
        entry = { score: 0, ranks: lists.map(() => null) };
        scores.set(id, entry);
      }
      entry.score += weight / (k + rank + 1);
      entry.ranks[armIndex] = rank;
    });
  });

  return [...scores.entries()]
    .map(([id, { score, ranks }]) => ({ id, score, ranks }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
