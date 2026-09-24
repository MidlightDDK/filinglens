// Retrieval metrics over chunk rankings (no LLM). A chunk is relevant to an item
// when it overlaps one of the item's gold spans by >= 30 characters (or covers
// the whole span, if it is shorter).
import type { GoldSpan } from "./dataset.ts";

export const MIN_OVERLAP = 30;

export interface ChunkSpan {
  doc_id: string;
  char_start: number;
  char_end: number;
}

export interface Scores {
  recall_at_5: number;
  recall_at_10: number;
  mrr_at_10: number;
  ndcg_at_10: number;
}

export const METRICS = [
  "recall_at_5",
  "recall_at_10",
  "mrr_at_10",
  "ndcg_at_10",
] as const satisfies readonly (keyof Scores)[];

export function overlaps(c: ChunkSpan, g: GoldSpan): boolean {
  if (c.doc_id !== g.doc_id) return false;
  const shared =
    Math.min(c.char_end, g.char_end) - Math.max(c.char_start, g.char_start);
  return shared >= Math.min(MIN_OVERLAP, g.char_end - g.char_start);
}

/** The evidence groups (see GoldSpan) a chunk covers. */
function groupsHit(c: ChunkSpan, gold: GoldSpan[]): Set<string> {
  const hit = new Set<string>();
  gold.forEach((g, i) => {
    if (overlaps(c, g)) hit.add(g.group ?? `#${i}`);
  });
  return hit;
}

/** Relevant chunks in the whole index: the ideal ranking for nDCG. */
export function countRelevant(chunks: ChunkSpan[], gold: GoldSpan[]): number {
  return chunks.filter((c) => gold.some((g) => overlaps(c, g))).length;
}

/**
 * - recall@k: share of evidence groups covered by the top k chunks.
 * - MRR@10: 1 / rank of the first relevant chunk.
 * - nDCG@10: binary relevance per chunk; the ideal ranking puts
 *   min(nRelevant, 10) relevant chunks first.
 * Returns null for items without gold spans (e.g. unanswerable).
 */
export function scoreRanking(
  ranked: ChunkSpan[],
  gold: GoldSpan[],
  nRelevant: number,
): Scores | null {
  if (gold.length === 0) return null;
  const groups = new Set(gold.map((g, i) => g.group ?? `#${i}`));
  const covered = new Set<string>();
  const recall: number[] = [];
  let rr = 0;
  let dcg = 0;
  ranked.slice(0, 10).forEach((c, i) => {
    const hit = groupsHit(c, gold);
    for (const g of hit) covered.add(g);
    recall.push(covered.size / groups.size);
    if (hit.size > 0) {
      if (rr === 0) rr = 1 / (i + 1);
      dcg += 1 / Math.log2(i + 2);
    }
  });
  let idcg = 0;
  for (let i = 0; i < Math.min(nRelevant, 10); i++)
    idcg += 1 / Math.log2(i + 2);
  const at = (k: number) => recall[Math.min(k, recall.length) - 1] ?? 0;
  return {
    recall_at_5: at(5),
    recall_at_10: at(10),
    mrr_at_10: rr,
    ndcg_at_10: idcg > 0 ? dcg / idcg : 0,
  };
}

export type Aggregate = Scores & { n: number };

export function mean(rows: Scores[]): Aggregate {
  const out: Aggregate = {
    recall_at_5: 0,
    recall_at_10: 0,
    mrr_at_10: 0,
    ndcg_at_10: 0,
    n: rows.length,
  };
  for (const m of METRICS) {
    const sum = rows.reduce((s, r) => s + r[m], 0);
    out[m] = rows.length ? Math.round((sum / rows.length) * 10000) / 10000 : 0;
  }
  return out;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, i)] as number;
}
