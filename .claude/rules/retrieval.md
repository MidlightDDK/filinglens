---
paths:
  - "packages/core/**"
  - "scripts/**"
---
# Retrieval, prompt, citations (`packages/core`, TypeScript)

## One implementation, three callers
The browser (in a Web Worker), the Worker (prompt building and verification), and the eval runners (Node) all import `packages/core`. Inject environment-specific I/O (file loading, model loading, fetch) through small interfaces; never fork logic per caller.

## Models (Hub IDs and revision SHAs pinned in `packages/core/src/models.ts`)
- Transformers.js v4 (`@huggingface/transformers`), one pinned version for web and scripts.
- Embeddings: a small English model with a Transformers.js ONNX export (bge-small-en-v1.5 class, 384 dimensions), same dtype in Node and in the browser. Apply the query prefix from its model card.
- Reranker (optional stage): a small cross-encoder with a Transformers.js ONNX export (ms-marco-MiniLM-L-6-v2 class). Keep it only if evals show a gain worth its latency.

## Index: `pnpm index` → `web/public/index/{strategy}/`
- `vectors.i8.bin`: int8, row-major n×dim, L2-normalized before quantizing, plus `scales.f32.bin` (per-row scale).
- `chunks/{shard}.json`: 256 shards by hash of `chunk_id`, mapping chunk_id → {text, doc_id, char_start, char_end, heading_path}. Small shards keep Worker CPU low and let the browser fetch only the chunks it shows.
- `lexical.json`: BM25 via MiniSearch or a small custom BM25 (pick one and note why).
- `docs.json`: doc_id → company, ticker, aliases, fy, SEC URL.
- `meta.json`: model id, revision, dim, n, strategy, corpus hash.
- Budget: ≤ 12 MB compressed per strategy; every file < 25 MiB (the Workers static-asset limit); ≤ 3 strategies in total (the 20,000 static-file limit). Output is deterministic (stable ids, sorted keys).

## Retrieval config (versioned JSON in `evals/configs/`; `default.json` is what the app uses)
1. Query → metadata filters: company aliases and tickers from `docs.json`; fiscal years by regex; "last year" means the latest FY in the corpus.
2. Lexical top-50 and dense top-50 inside the filters (brute-force int8 cosine is fine at this size).
3. Reciprocal Rank Fusion (k = 60).
4. Optional rerank of the top 30 → top-k (default 8).
5. Optional LLM query decomposition for multi-company or multi-year questions (off unless evals justify it).
Return every candidate with lexical, dense, fused, and rerank scores plus stage timings; the UI shows them.

## Prompt (assembled only in the Worker, from trusted chunk text)
- Rules: use only SOURCES; end every sentence with markers like `[2]` or `[2][5]`; copy numbers exactly with units and fiscal year; if the sources are insufficient, reply exactly `INSUFFICIENT_EVIDENCE: <what is missing>`; correct false premises explicitly; no outside knowledge; ≤ 180 words unless asked.
- SOURCES: numbered blocks with company, FY, item, heading, text.
- Export `PROMPT_VERSION` and bump it on any prompt change; cache keys and eval reports include it.

## Citations and verification (pure functions, heavily unit-tested)
- Sentence splitter robust to "$1.2 billion.", "U.S.", decimals, and list items. Markers map to chunk ids; drop markers that point outside SOURCES.
- Number normalizer: commas, %, $, million/billion/thousand, parentheses as negatives, per-share values.
- Per sentence: `verified` (at least one valid citation and every number appears in a cited chunk, or is one arithmetic step (difference, sum, ratio, percent change) from two numbers of the same answer that do), `unverified` (no citation, or a number not found), `unsupported` (the optional LLM judge says the cited text doesn't support it). Markers may be ASCII `[2]` or full-width `【2】` (gpt-oss).
- Highlight span: inside the cited chunk, prefer the number match, else the window with the largest token overlap.

