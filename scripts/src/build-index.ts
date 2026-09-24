// `pnpm index [--strategy <name>]...`: data/processed/chunks/{strategy}.jsonl →
// web/public/index/{strategy}/ (see .claude/rules/retrieval.md for the layout).
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import {
  buildLexicalIndex,
  type ChunkRecord,
  type Docs,
  EMBEDDING_MODEL,
  type IndexMeta,
  type IndexRows,
  quantize,
  SHARDS,
  shardOf,
} from "@filinglens/core";
import { INDEX_DIR, loadNodeEmbedder, REPO_ROOT } from "@filinglens/core/node";

const CHUNKS_DIR = `${REPO_ROOT}data/processed/chunks`;
const MANIFEST = `${REPO_ROOT}data/raw/manifest.json`;
const EMBED_CACHE = `${REPO_ROOT}data/cache/embeddings/${EMBEDDING_MODEL.id.replace("/", "--")}@${EMBEDDING_MODEL.revision.slice(0, 12)}-${EMBEDDING_MODEL.dtype}-native.bin`;
const BUDGET_BYTES = 12_000_000; // compressed, per strategy
const FILE_LIMIT = 25 * 1024 * 1024; // Workers static-asset limit

// Extra names for query filters; the company name and ticker always match.
const ALIASES: Record<string, string[]> = {
  AMD: ["Advanced Micro Devices"],
  GOOGL: ["Google", "GOOG"],
  JPM: ["JPMorgan", "JP Morgan", "J.P. Morgan", "Chase"],
  KO: ["Coca Cola", "Coke"],
  META: ["Meta", "Facebook"],
  PEP: ["Pepsi"],
};

interface ChunkLine {
  chunk_id: string;
  doc_id: string;
  item: string;
  heading_path: string[];
  char_start: number;
  char_end: number;
  text: string;
}

interface ManifestEntry {
  doc_id: string;
  ticker: string;
  company: string;
  fy: number;
  filing_date: string;
  url: string;
}

/** JSON with object keys sorted, so output bytes are deterministic. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest();

/** Content-addressed embedding cache: records of sha256(text) + dim float32. */
function loadCache(dim: number): Map<string, Float32Array> {
  const cache = new Map<string, Float32Array>();
  if (!existsSync(EMBED_CACHE)) return cache;
  const buf = readFileSync(EMBED_CACHE);
  const size = 32 + dim * 4;
  // Drop a record cut short by an interrupted run, so appends stay aligned.
  if (buf.length % size !== 0)
    truncateSync(EMBED_CACHE, buf.length - (buf.length % size));
  for (let off = 0; off + size <= buf.length; off += size) {
    const key = buf.subarray(off, off + 32).toString("hex");
    const vec = new Float32Array(dim);
    Buffer.from(vec.buffer).set(buf.subarray(off + 32, off + size));
    cache.set(key, vec);
  }
  return cache;
}

async function embedAll(texts: string[]): Promise<Float32Array[]> {
  const { dim } = EMBEDDING_MODEL;
  const cache = loadCache(dim);
  const keys = texts.map((t) => sha256(t).toString("hex"));
  const todo = [...new Set(keys.filter((k) => !cache.has(k)))];
  console.log(
    `  embeddings: ${keys.length - todo.length} reused, ${todo.length} to compute`,
  );
  if (todo.length > 0) {
    mkdirSync(`${REPO_ROOT}data/cache/embeddings`, { recursive: true });
    const embedder = await loadNodeEmbedder("native");
    const byKey = new Map(keys.map((k, i) => [k, texts[i] ?? ""]));
    const start = performance.now();
    for (let i = 0; i < todo.length; i++) {
      const key = todo[i] ?? "";
      // Batch size 1: no padding, and each vector is independent of its neighbours.
      const [vec] = await embedder.embed([byKey.get(key) ?? ""]);
      if (!vec) throw new Error("embedding failed");
      cache.set(key, vec);
      appendFileSync(
        EMBED_CACHE,
        Buffer.concat([
          Buffer.from(key, "hex"),
          Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
        ]),
      );
      if ((i + 1) % 250 === 0 || i + 1 === todo.length) {
        const rate = (i + 1) / ((performance.now() - start) / 1000);
        const eta = Math.round((todo.length - i - 1) / rate);
        console.log(
          `  embedded ${i + 1}/${todo.length} (${rate.toFixed(1)}/s, ETA ${eta}s)`,
        );
      }
    }
  }
  return keys.map((k) => {
    const vec = cache.get(k);
    if (!vec) throw new Error(`missing embedding ${k}`);
    return vec;
  });
}

function buildDocs(): Docs {
  const manifest: ManifestEntry[] = JSON.parse(readFileSync(MANIFEST, "utf8"));
  return Object.fromEntries(
    manifest.map((m) => [
      m.doc_id,
      {
        company: m.company,
        ticker: m.ticker,
        aliases: ALIASES[m.ticker] ?? [],
        fy: m.fy,
        filing_date: m.filing_date,
        url: m.url,
      },
    ]),
  );
}

/** Structure chunks start with a "Company FYxxxx 10-K | …" context line; the store keeps the body. */
function body(chunk: ChunkLine, docs: Docs): string {
  const d = docs[chunk.doc_id];
  const prefix = d ? `${d.company} FY${d.fy} 10-K | ` : null;
  if (prefix && chunk.text.startsWith(prefix)) {
    const cut = chunk.text.indexOf("\n\n");
    if (cut >= 0) return chunk.text.slice(cut + 2);
  }
  return chunk.text;
}

function report(dir: string): { total: number; ok: boolean } {
  const groups = new Map<string, { raw: number; gz: number; files: number }>();
  let ok = true;
  const walk = (d: string, group?: string) => {
    for (const name of readdirSync(d).sort()) {
      const path = `${d}/${name}`;
      if (statSync(path).isDirectory()) {
        walk(path, `${name}/`);
        continue;
      }
      const data = readFileSync(path);
      if (data.length > FILE_LIMIT) {
        console.error(`  ${path} is ${data.length} bytes (> 25 MiB)`);
        ok = false;
      }
      const g = groups.get(group ?? name) ?? { raw: 0, gz: 0, files: 0 };
      g.raw += data.length;
      g.gz += gzipSync(data, { level: 9 }).length;
      g.files += 1;
      groups.set(group ?? name, g);
    }
  };
  walk(dir);
  const mb = (n: number) => (n / 1e6).toFixed(2).padStart(7);
  let total = 0;
  for (const [name, g] of groups) {
    total += g.gz;
    console.log(
      `  ${name.padEnd(16)} ${mb(g.raw)} MB raw ${mb(g.gz)} MB gz  (${g.files} files)`,
    );
  }
  console.log(
    `  ${"total".padEnd(16)} ${" ".repeat(15)}${mb(total)} MB gz  (budget ${BUDGET_BYTES / 1e6} MB)`,
  );
  return { total, ok: ok && total <= BUDGET_BYTES };
}

async function buildStrategy(strategy: string, docs: Docs): Promise<boolean> {
  console.log(`\n[${strategy}]`);
  const raw = readFileSync(`${CHUNKS_DIR}/${strategy}.jsonl`, "utf8");
  const chunks: ChunkLine[] = raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const texts = chunks.map((c) => c.text);
  const { dim } = EMBEDDING_MODEL;

  const vectors = await embedAll(texts);
  const { values, scales } = quantize(vectors, dim);

  const out = `${INDEX_DIR}/${strategy}`;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(`${out}/chunks`, { recursive: true });

  writeFileSync(`${out}/vectors.i8.bin`, new Uint8Array(values.buffer));
  writeFileSync(`${out}/scales.f32.bin`, new Uint8Array(scales.buffer));
  writeFileSync(`${out}/lexical.json`, stable(buildLexicalIndex(texts)));
  const rows: IndexRows = {
    chunk_ids: chunks.map((c) => c.chunk_id),
    doc_ids: chunks.map((c) => c.doc_id),
  };
  writeFileSync(`${out}/rows.json`, stable(rows));
  const used = new Set(rows.doc_ids);
  writeFileSync(
    `${out}/docs.json`,
    stable(
      Object.fromEntries(Object.entries(docs).filter(([id]) => used.has(id))),
    ),
  );

  const shards = Array.from(
    { length: SHARDS },
    () => ({}) as Record<string, ChunkRecord>,
  );
  for (const c of chunks) {
    const shard = shards[Number.parseInt(shardOf(c.chunk_id), 16)];
    if (!shard) throw new Error("bad shard");
    shard[c.chunk_id] = {
      text: body(c, docs),
      doc_id: c.doc_id,
      item: c.item,
      heading_path: c.heading_path,
      char_start: c.char_start,
      char_end: c.char_end,
    };
  }
  shards.forEach((s, i) => {
    writeFileSync(
      `${out}/chunks/${i.toString(16).padStart(2, "0")}.json`,
      stable(s),
    );
  });

  const meta: IndexMeta = {
    strategy,
    model: EMBEDDING_MODEL.id,
    revision: EMBEDDING_MODEL.revision,
    dtype: EMBEDDING_MODEL.dtype,
    dim,
    n: chunks.length,
    corpus_hash: sha256(raw).toString("hex"),
  };
  writeFileSync(`${out}/meta.json`, stable(meta));

  const { ok } = report(out);
  if (!ok) console.error(`  [${strategy}] over budget`);
  return ok;
}

const { values: args } = parseArgs({
  options: { strategy: { type: "string", multiple: true } },
});
const strategies =
  args.strategy ??
  readdirSync(CHUNKS_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(/\.jsonl$/, ""))
    .sort();
const docs = buildDocs();
let ok = true;
for (const s of strategies) ok = (await buildStrategy(s, docs)) && ok;
if (!ok) process.exitCode = 1;
