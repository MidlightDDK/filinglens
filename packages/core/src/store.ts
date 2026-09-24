import type { Docs } from "./filters.ts";
import {
  type LexicalIndex,
  type LexicalIndexFile,
  loadLexicalIndex,
} from "./lexical.ts";

/** Environment-specific file access, relative to the index root (`web/public/index`). */
export interface IndexSource {
  json<T>(path: string): Promise<T>;
  bytes(path: string): Promise<ArrayBuffer>;
}

export interface IndexMeta {
  strategy: string;
  model: string;
  revision: string;
  dtype: string;
  dim: number;
  n: number;
  corpus_hash: string;
}

/** `rows.json`: row i of every per-row array is chunk_ids[i]. */
export interface IndexRows {
  chunk_ids: string[];
  doc_ids: string[];
}

/** One chunk as stored in `chunks/{shard}.json`. `text` is the body only. */
export interface ChunkRecord {
  text: string;
  doc_id: string;
  item: string;
  heading_path: string[];
  char_start: number;
  char_end: number;
}

export interface LoadedIndex {
  meta: IndexMeta;
  docs: Docs;
  rows: IndexRows;
  lexical: LexicalIndex;
  vectors: Int8Array;
  scales: Float32Array;
}

export const SHARDS = 256;

/** Shard file name for a chunk id: FNV-1a (32-bit) mod 256, as two hex digits. */
export function shardOf(chunkId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < chunkId.length; i++) {
    h ^= chunkId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % SHARDS).toString(16).padStart(2, "0");
}

export async function loadIndex(
  source: IndexSource,
  strategy: string,
): Promise<LoadedIndex> {
  const [meta, docs, rows, lexical, vectors, scales] = await Promise.all([
    source.json<IndexMeta>(`${strategy}/meta.json`),
    source.json<Docs>(`${strategy}/docs.json`),
    source.json<IndexRows>(`${strategy}/rows.json`),
    source.json<LexicalIndexFile>(`${strategy}/lexical.json`),
    source.bytes(`${strategy}/vectors.i8.bin`),
    source.bytes(`${strategy}/scales.f32.bin`),
  ]);
  const index = {
    meta,
    docs,
    rows,
    lexical: loadLexicalIndex(lexical),
    vectors: new Int8Array(vectors),
    scales: new Float32Array(scales),
  };
  if (
    index.scales.length !== meta.n ||
    index.vectors.length !== meta.n * meta.dim ||
    rows.chunk_ids.length !== meta.n
  ) {
    throw new Error(`index ${strategy} is inconsistent with meta.json`);
  }
  return index;
}

/** Fetches chunk text on demand, one shard at a time, with a shard cache. */
export class ChunkStore {
  private readonly shards = new Map<
    string,
    Promise<Record<string, ChunkRecord>>
  >();
  private readonly source: IndexSource;
  private readonly strategy: string;

  constructor(source: IndexSource, strategy: string) {
    this.source = source;
    this.strategy = strategy;
  }

  async get(ids: string[]): Promise<Map<string, ChunkRecord>> {
    const found = await Promise.all(
      ids.map(async (id) => {
        const shard = shardOf(id);
        let p = this.shards.get(shard);
        if (!p) {
          p = this.source
            .json<Record<string, ChunkRecord>>(
              `${this.strategy}/chunks/${shard}.json`,
            )
            .catch((err: unknown) => {
              this.shards.delete(shard); // retry on the next call
              throw err;
            });
          this.shards.set(shard, p);
        }
        const chunk = (await p)[id];
        if (!chunk) throw new Error(`chunk ${id} not in shard ${shard}`);
        return [id, chunk] as const;
      }),
    );
    return new Map(found);
  }
}
