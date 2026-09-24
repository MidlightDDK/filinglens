import { describe, expect, it } from "vitest";
import { quantize } from "./dense.ts";
import type { Embedder } from "./embed.ts";
import type { Docs } from "./filters.ts";
import { buildLexicalIndex } from "./lexical.ts";
import { type RetrievalConfig, retrieve, rrf } from "./retrieve.ts";
import {
  type ChunkRecord,
  ChunkStore,
  type IndexSource,
  loadIndex,
  shardOf,
} from "./store.ts";

describe("rrf", () => {
  it("sums 1/(k + rank) across lists and breaks ties by row", () => {
    const fused = rrf(
      [
        [
          { row: 5, score: 9 },
          { row: 7, score: 8 },
        ],
        [
          { row: 7, score: 0.9 },
          { row: 2, score: 0.8 },
        ],
      ],
      60,
    );
    expect(fused.map((h) => h.row)).toEqual([7, 5, 2]);
    expect(fused[0]?.score).toBeCloseTo(1 / 62 + 1 / 61, 10);
    expect(fused[1]?.score).toBeCloseTo(1 / 61, 10);
  });
});

describe("shardOf", () => {
  it("is stable and in range", () => {
    expect(shardOf("AAPL-FY2025-structure-00000")).toMatch(/^[0-9a-f]{2}$/);
    expect(shardOf("x")).toBe(shardOf("x"));
  });
});

// A tiny in-memory index with 2-d vectors and a fake embedder.
const texts = [
  "Apple FY2025 iPhone net sales",
  "Apple FY2024 iPhone net sales",
  "NVIDIA FY2026 data center revenue",
  "NVIDIA FY2026 gaming revenue",
];
const chunkIds = [
  "AAPL-FY2025-0",
  "AAPL-FY2024-0",
  "NVDA-FY2026-0",
  "NVDA-FY2026-1",
];
const docIds = ["AAPL-FY2025", "AAPL-FY2024", "NVDA-FY2026", "NVDA-FY2026"];
const docs: Docs = {
  "AAPL-FY2024": {
    company: "Apple",
    ticker: "AAPL",
    aliases: [],
    fy: 2024,
    filing_date: "",
    url: "",
  },
  "AAPL-FY2025": {
    company: "Apple",
    ticker: "AAPL",
    aliases: [],
    fy: 2025,
    filing_date: "",
    url: "",
  },
  "NVDA-FY2026": {
    company: "NVIDIA",
    ticker: "NVDA",
    aliases: [],
    fy: 2026,
    filing_date: "",
    url: "",
  },
};
const vecs = [
  [1, 0],
  [0.9, 0.1],
  [0, 1],
  [0.2, 0.8],
].map((v) => Float32Array.from(v));
const { values, scales } = quantize(vecs, 2);
const shards: Record<string, Record<string, ChunkRecord>> = {};
chunkIds.forEach((id, i) => {
  shards[shardOf(id)] ??= {};
  (shards[shardOf(id)] as Record<string, ChunkRecord>)[id] = {
    text: texts[i] ?? "",
    doc_id: docIds[i] ?? "",
    item: "7",
    heading_path: [],
    char_start: 0,
    char_end: 1,
  };
});
const files: Record<string, unknown> = {
  "t/meta.json": {
    strategy: "t",
    model: "m",
    revision: "r",
    dtype: "q8",
    dim: 2,
    n: 4,
    corpus_hash: "",
  },
  "t/docs.json": docs,
  "t/rows.json": { chunk_ids: chunkIds, doc_ids: docIds },
  "t/lexical.json": buildLexicalIndex(texts),
};
for (const [shard, records] of Object.entries(shards)) {
  files[`t/chunks/${shard}.json`] = records;
}
const source: IndexSource = {
  json: async (path) => structuredClone(files[path]) as never,
  bytes: async (path) =>
    (path.endsWith("vectors.i8.bin") ? values : scales).slice().buffer,
};
const embedder: Embedder = {
  device: "cpu",
  embed: async () => [],
  // Every query "means" data center.
  embedQuery: async () => Float32Array.from([0, 1]),
};
const config: RetrievalConfig = {
  id: "test",
  strategy: "t",
  filters: true,
  lexical_k: 50,
  dense_k: 50,
  rrf_k: 60,
  rerank: null,
  top_k: 2,
};

describe("retrieve", () => {
  it("fuses lexical and dense ranks and reports every score", async () => {
    const index = await loadIndex(source, "t");
    const r = await retrieve(index, "gaming", config, { embedder });
    expect(r.candidates.map((c) => c.chunk_id)).toEqual([
      "NVDA-FY2026-1",
      "NVDA-FY2026-0",
      "AAPL-FY2024-0",
      "AAPL-FY2025-0",
    ]);
    const [first] = r.candidates;
    expect(first?.lexical?.rank).toBe(1);
    expect(first?.dense?.rank).toBe(2);
    expect(r.top).toHaveLength(2);
    expect(r.timings.total_ms).toBeGreaterThanOrEqual(0);
  });

  it("applies query filters to both retrievers", async () => {
    const index = await loadIndex(source, "t");
    const r = await retrieve(index, "Apple FY2024 iPhone sales", config, {
      embedder,
    });
    expect(r.filters.doc_ids).toEqual(["AAPL-FY2024"]);
    expect(r.candidates.map((c) => c.chunk_id)).toEqual(["AAPL-FY2024-0"]);
  });

  it("disables a retriever when its k is 0", async () => {
    const index = await loadIndex(source, "t");
    const r = await retrieve(
      index,
      "iPhone",
      { ...config, dense_k: 0, filters: false },
      { embedder },
    );
    expect(r.candidates.every((c) => c.dense === null)).toBe(true);
    expect(r.candidates).toHaveLength(2);
  });

  it("reranks the top_n through the injected reranker", async () => {
    const index = await loadIndex(source, "t");
    const chunks = new ChunkStore(source, "t");
    const reranker = {
      // Prefers Apple passages.
      score: async (_q: string, passages: string[]) =>
        passages.map((p) => (p.startsWith("Apple") ? 1 : 0)),
    };
    const r = await retrieve(
      index,
      "revenue",
      { ...config, rerank: { top_n: 3 } },
      { embedder, reranker, chunks },
    );
    expect(
      r.candidates.map((c) => [c.chunk_id, c.rerank?.rank ?? null]),
    ).toEqual([
      ["AAPL-FY2024-0", 1],
      ["NVDA-FY2026-0", 2],
      ["NVDA-FY2026-1", 3],
      ["AAPL-FY2025-0", null],
    ]);
  });

  it("rejects an index whose files disagree with meta.json", async () => {
    const bad: IndexSource = {
      ...source,
      json: async (path) =>
        path.endsWith("meta.json")
          ? ({ ...(files[path] as object), n: 5 } as never)
          : (source.json(path) as never),
    };
    await expect(loadIndex(bad, "t")).rejects.toThrow(/inconsistent/);
  });
});
