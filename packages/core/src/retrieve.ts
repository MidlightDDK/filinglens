import { searchDense } from "./dense.ts";
import type { Embedder } from "./embed.ts";
import { detectFilters, type QueryFilters } from "./filters.ts";
import { type Hit, searchLexical } from "./lexical.ts";
import type { ChunkStore, LoadedIndex } from "./store.ts";

/** A versioned retrieval config (`evals/configs/*.json`). */
export interface RetrievalConfig {
  id: string;
  strategy: string;
  /** Apply company / fiscal-year filters detected in the query. */
  filters: boolean;
  /** Candidates per retriever; 0 disables that retriever. */
  lexical_k: number;
  dense_k: number;
  rrf_k: number;
  /** Rerank the top `top_n` fused candidates, or null to skip. */
  rerank: { top_n: number } | null;
  top_k: number;
}

/** Optional cross-encoder stage: one relevance score per passage. */
export interface Reranker {
  score(query: string, passages: string[]): Promise<number[]>;
}

export interface Ranked {
  rank: number;
  score: number;
}

export interface Candidate {
  chunk_id: string;
  doc_id: string;
  lexical: Ranked | null;
  dense: Ranked | null;
  fused: Ranked;
  rerank: Ranked | null;
}

export interface Timings {
  filter_ms: number;
  embed_ms: number;
  lexical_ms: number;
  dense_ms: number;
  fuse_ms: number;
  rerank_ms: number;
  total_ms: number;
}

export interface RetrievalResult {
  query: string;
  config_id: string;
  filters: QueryFilters;
  /** Every fused candidate, in final order (after rerank when enabled). */
  candidates: Candidate[];
  /** The first `top_k` candidates. */
  top: Candidate[];
  timings: Timings;
}

export interface RetrieveDeps {
  embedder: Embedder;
  reranker?: Reranker;
  /** Needed only when reranking (the reranker reads chunk text). */
  chunks?: ChunkStore;
}

const round = (ms: number) => Math.round(ms * 10) / 10;

/** Reciprocal Rank Fusion over ranked row lists: Σ 1 / (k + rank). */
export function rrf(lists: Hit[][], k: number): Hit[] {
  const fused = new Map<number, number>();
  for (const list of lists) {
    list.forEach(({ row }, i) => {
      fused.set(row, (fused.get(row) ?? 0) + 1 / (k + i + 1));
    });
  }
  return [...fused]
    .map(([row, score]) => ({ row, score }))
    .sort((x, y) => y.score - x.score || x.row - y.row);
}

export async function retrieve(
  index: LoadedIndex,
  query: string,
  config: RetrievalConfig,
  deps: RetrieveDeps,
): Promise<RetrievalResult> {
  const t0 = performance.now();
  const { rows, docs, meta } = index;

  const filters = detectFilters(query, {}); // DELIBERATELY BROKEN: gate proof, do not merge
  let allowed: Uint8Array | null = null;
  if (filters.doc_ids) {
    const ids = new Set(filters.doc_ids);
    allowed = Uint8Array.from(rows.doc_ids, (d) => (ids.has(d) ? 1 : 0));
  }
  const t1 = performance.now();

  const lexical =
    config.lexical_k > 0
      ? searchLexical(index.lexical, query, allowed, config.lexical_k)
      : [];
  const t2 = performance.now();

  let dense: Hit[] = [];
  let t3 = t2;
  if (config.dense_k > 0) {
    const q = await deps.embedder.embedQuery(query);
    t3 = performance.now();
    dense = searchDense(
      index.vectors,
      index.scales,
      meta.dim,
      q,
      allowed,
      config.dense_k,
    );
  }
  const t4 = performance.now();

  const rankOf = (list: Hit[]) =>
    new Map(list.map((h, i) => [h.row, { rank: i + 1, score: h.score }]));
  const lexRank = rankOf(lexical);
  const denseRank = rankOf(dense);
  let candidates: Candidate[] = rrf([lexical, dense], config.rrf_k).map(
    (h, i) => ({
      chunk_id: rows.chunk_ids[h.row] ?? "",
      doc_id: rows.doc_ids[h.row] ?? "",
      lexical: lexRank.get(h.row) ?? null,
      dense: denseRank.get(h.row) ?? null,
      fused: { rank: i + 1, score: h.score },
      rerank: null,
    }),
  );
  const t5 = performance.now();

  if (config.rerank && deps.reranker && deps.chunks) {
    const head = candidates.slice(0, config.rerank.top_n);
    const texts = await deps.chunks.get(head.map((c) => c.chunk_id));
    const scores = await deps.reranker.score(
      query,
      head.map((c) => texts.get(c.chunk_id)?.text ?? ""),
    );
    const reranked = head
      .map((c, i) => ({ c, score: scores[i] ?? Number.NEGATIVE_INFINITY }))
      .sort((x, y) => y.score - x.score || x.c.fused.rank - y.c.fused.rank)
      .map(({ c, score }, i) => ({ ...c, rerank: { rank: i + 1, score } }));
    candidates = [...reranked, ...candidates.slice(head.length)];
  }
  const t6 = performance.now();

  return {
    query,
    config_id: config.id,
    filters,
    candidates,
    top: candidates.slice(0, config.top_k),
    timings: {
      filter_ms: round(t1 - t0),
      lexical_ms: round(t2 - t1),
      embed_ms: round(t3 - t2),
      dense_ms: round(t4 - t3),
      fuse_ms: round(t5 - t4),
      rerank_ms: round(t6 - t5),
      total_ms: round(t6 - t0),
    },
  };
}
