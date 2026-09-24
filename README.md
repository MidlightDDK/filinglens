# FilingLens

Citation-verified Q&A over SEC 10-K filings. Ask a question about the annual reports of about 12 public companies. Every sentence in the answer cites its source passage, sentences that can't be verified are flagged, and questions the filings can't answer are declined.

> **Under construction.** The live demo, eval results, and setup instructions will appear here as milestones land.

## Data sources and terms

| Source | Used for | Terms |
| --- | --- | --- |
| [SEC EDGAR](https://www.sec.gov/edgar): `company_tickers.json`, the submissions API, and 10-K primary documents | The filings corpus (`pipeline/config/corpus.yaml`) | U.S. government public data. Downloads follow the [fair-access policy](https://www.sec.gov/os/accessing-edgar-data): a declared User-Agent, at most 5 requests per second (the cap is 10), and a local cache so each file is fetched only once. |
| [`Xenova/bge-small-en-v1.5`](https://huggingface.co/Xenova/bge-small-en-v1.5) `tokenizer.json`, pinned revision `ea104dac` | Chunk token counts; passage and query embeddings (`onnx/model_quantized.onnx`, q8), in Node at index time and in your browser at query time | ONNX conversion of [`BAAI/bge-small-en-v1.5`](https://huggingface.co/BAAI/bge-small-en-v1.5) (MIT). The browser downloads it from huggingface.co. |
| [onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web) WASM via [jsDelivr](https://www.jsdelivr.com/terms) | Running the embedding model in the browser | MIT; Transformers.js loads it from cdn.jsdelivr.net. |
| SEC EDGAR [XBRL company facts API](https://www.sec.gov/search-filings/edgar-application-programming-interfaces) | Numeric eval items with exact answers (`pnpm data:xbrl` → `evals/datasets/xbrl_numeric.jsonl`) | Same as EDGAR above. |
| [`Xenova/ms-marco-MiniLM-L-6-v2`](https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2), pinned revision `a0914435` | A cross-encoder rerank stage that was evaluated but not shipped (see Design decisions) | ONNX conversion of [`cross-encoder/ms-marco-MiniLM-L-6-v2`](https://huggingface.co/cross-encoder/ms-marco-MiniLM-L-6-v2) (Apache-2.0). |
| [Groq](https://groq.com/terms-of-use) free tier, `openai/gpt-oss-120b` | Proposing synthetic eval questions (`pnpm eval:synth`), which a person reviews before they enter the eval set; second fallback for live answers | Model weights Apache-2.0. Free tier, no card needed. |
| [Cloudflare Workers AI](https://www.cloudflare.com/service-specific-terms-developer-platform/) free allocation, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | First choice for live answers (`worker/src/providers/`) | [Llama 3.3 Community License](https://www.llama.com/llama3_3/license/). 10k free neurons a day, roughly 70 answers. |
| [Google Gemini API](https://ai.google.dev/gemini-api/terms) free tier, `gemini-3.5-flash-lite` | Last fallback for live answers | Free tier, no card needed. Google may use free-tier prompts to improve its products; prompts contain only public filing text and the visitor's question. |
| [Cloudflare Turnstile](https://www.cloudflare.com/turnstile-terms-of-use/) | Bot check before a visitor can request live answers | Free; no personal data is stored by FilingLens. |

Raw filings and processed text live in `data/` and are not committed. Run `pnpm data:ingest` (needs `SEC_USER_AGENT="Full Name email@example.com"`), then `pnpm data:chunk`. `pnpm index` then builds the search index into `web/public/index/` (also not committed).

## Design decisions

- **Biome instead of ESLint + Prettier:** one dependency and one config handle both linting and formatting, and it runs much faster. It is set to Prettier's default output style.
- **Vite dev proxy instead of the Cloudflare Vite plugin:** `pnpm dev` runs `vite` and `wrangler dev` side by side, and Vite forwards `/api` to the Worker. This keeps a single deploy path (`wrangler deploy` in `worker/` serving `web/dist`). The plugin would replace the build output and deploy config with its own layout.
- **Custom BM25 instead of MiniSearch:** the lexical index is a compact term → postings map with deterministic output and no dependency, and one tokenizer (`packages/core/src/lexical.ts`) runs at build time and query time.
- **q8 embeddings everywhere:** Node and the browser run the same quantized ONNX file (34 MB instead of 133 MB), so indexed and query vectors come from the same weights.
- **Queries in Node use the browser's WASM runtime:** onnxruntime-node's x86 int8 kernels give slightly different vectors than WASM (cosine ~0.998 on some inputs), enough to reorder close results. Evals and the parity test embed queries with onnxruntime-web, so Node and the browser return identical rankings. Passages are embedded once at index time with the ~10x faster onnxruntime-node.

- **Answers go through a Worker gateway with a provider chain:** Workers AI, then Groq, then Gemini. A provider that returns 429 or 5xx, or sends no first token within 8 s, is skipped for 60 s. The Worker loads passage text from its own static index and never trusts text sent by the browser. Answers are cached in Workers KV for 7 days, keyed by prompt version, config, normalized question, and passage ids. `/api/answer` needs a 30-minute session cookie issued after a Turnstile check, and is rate-limited per IP.
- **Workers AI tokens are read from `choices[].delta.content`:** its stream also carries a legacy `response` field that turns numeric tokens into JSON numbers (`" 2025"` becomes `2025`, `"0"` becomes `0`), which silently drops spaces and zeros from figures.

### Retrieval config, chosen from dev metrics

The app uses `evals/configs/default.json`: structure-aware chunks, BM25 and dense search fused with Reciprocal Rank Fusion (k = 60), company and fiscal-year filters taken from the question, and no reranker. It had the best overall score on every quality metric in the dev-split comparison below: 127 dev items, 111 of them with gold evidence (unanswerable items have none). Reproduce with `pnpm eval:retrieval --config all --split dev`; per-category numbers are in `evals/reports/latest.json`.

| Config (`evals/configs/`) | Recall@5 | Recall@10 | MRR@10 | nDCG@10 | p50 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| **default**: hybrid + filters | **79.3** | **88.7** | **61.7** | **52.3** | 35 |
| lexical-only (BM25) | 65.8 | 79.7 | 52.0 | 45.6 | 2 |
| dense-only | 58.6 | 75.2 | 50.1 | 40.8 | 31 |
| no-filters | 60.8 | 72.1 | 44.8 | 36.0 | 50 |
| fixed: 350-token windows instead of structure chunks | 53.1 | 64.9 | 45.1 | 33.3 | 29 |
| rerank: default + cross-encoder on the top 30 | 74.3 | 86.0 | 52.8 | 48.7 | 6,869 |

- **Hybrid over either retriever alone:** fusion adds 9 points of recall@10 over BM25-only and 14 over dense-only. Dense-only is weakest on false-premise questions (36 vs 71), where exact figures and names matter.
- **Filters:** without them recall@10 falls 17 points, and 24 on two-company comparisons, where the question names both companies.
- **Structure-aware chunks:** fixed windows lose 24 points of recall@10.
- **No reranker:** the MS MARCO cross-encoder, trained on web search passages, lowered MRR@10 by 9 points and recall@10 by 3 (it helped only on lookup questions) and took about 7 s per query (Node, WASM), so the app does not download it.

Latency is measured in Node on the same WASM runtime the browser uses, one query at a time, including query embedding.

### Eval set v1

211 questions over the 24 filings, split 60/40 into dev and test within each category (`evals/datasets/golden.jsonl`). Evidence is stored as character offsets into each filing's text, so the labels don't depend on how the text is chunked.

| Category | Items | Sources |
| --- | ---: | --- |
| lookup | 34 | synthetic, reviewed |
| table_number | 36 | XBRL |
| comparison | 28 | XBRL 24, synthetic 4 |
| trend | 24 | XBRL |
| multi_hop | 40 | XBRL 24, handwritten 10, synthetic 6 |
| false_premise | 23 | handwritten 17, synthetic 6 |
| unanswerable | 26 | handwritten 11, synthetic 15 |

- **XBRL items** (`pnpm data:xbrl`) take exact values from SEC's structured data: single values, year-over-year changes, ratios, and two-company comparisons. They use the figure for the filing's own fiscal-year end, never a prior-year comparative.
- **Synthetic items** were proposed by `openai/gpt-oss-120b` on Groq from sampled passages. Quotes that weren't verbatim were dropped automatically, which left 94 proposals.
- **Review:** at the project owner's request, Claude (the AI coding assistant that built this repo) reviewed the proposals instead of a person: 65 kept (8 of them edited) and 29 rejected, with a reason for each in `evals/review/queue.csv`. Claude also wrote the 38 handwritten items (`evals/review/handwritten.csv`) and checked every answer against the filing text.

## License

[MIT](LICENSE)
