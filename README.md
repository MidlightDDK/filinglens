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
| [Groq](https://groq.com/terms-of-use) free tier, `openai/gpt-oss-120b` | Proposing synthetic eval questions (`pnpm eval:synth`), which a person reviews before they enter the eval set | Model weights Apache-2.0. Used offline only; no card needed. |

Raw filings and processed text live in `data/` and are not committed. Run `pnpm data:ingest` (needs `SEC_USER_AGENT="Full Name email@example.com"`), then `pnpm data:chunk`. `pnpm index` then builds the search index into `web/public/index/` (also not committed).

## Design decisions

- **Biome instead of ESLint + Prettier:** one dependency and one config handle both linting and formatting, and it runs much faster. It is set to Prettier's default output style.
- **Vite dev proxy instead of the Cloudflare Vite plugin:** `pnpm dev` runs `vite` and `wrangler dev` side by side, and Vite forwards `/api` to the Worker. This keeps a single deploy path (`wrangler deploy` in `worker/` serving `web/dist`). The plugin would replace the build output and deploy config with its own layout.
- **Custom BM25 instead of MiniSearch:** the lexical index is a compact term → postings map with deterministic output and no dependency, and one tokenizer (`packages/core/src/lexical.ts`) runs at build time and query time.
- **q8 embeddings everywhere:** Node and the browser run the same quantized ONNX file (34 MB instead of 133 MB), so indexed and query vectors come from the same weights.
- **Queries in Node use the browser's WASM runtime:** onnxruntime-node's x86 int8 kernels give slightly different vectors than WASM (cosine ~0.998 on some inputs), enough to reorder close results. Evals and the parity test embed queries with onnxruntime-web, so Node and the browser return identical rankings. Passages are embedded once at index time with the ~10x faster onnxruntime-node.

### Retrieval config, chosen from dev metrics

The app uses `evals/configs/default.json`: structure-aware chunks, BM25 and dense search fused with Reciprocal Rank Fusion (k = 60), company and fiscal-year filters taken from the question, and no reranker. It had the best score on every quality metric in the dev-split comparison below (eval set v1, 64 dev items: all XBRL-derived so far; the reviewed synthetic and handwritten items are next). Reproduce with `pnpm eval:retrieval --config all --split dev`; full per-category numbers are in `evals/reports/latest.json`.

| Config (`evals/configs/`) | Recall@5 | Recall@10 | MRR@10 | nDCG@10 | p50 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| **default**: hybrid + filters | **85.9** | **94.5** | **68.4** | **48.1** | 36 |
| dense-only | 67.2 | 88.3 | 58.9 | 40.8 | 33 |
| lexical-only (BM25) | 62.5 | 80.5 | 49.5 | 35.3 | 3 |
| no-filters | 64.8 | 74.2 | 48.5 | 29.2 | 51 |
| fixed: 350-token windows instead of structure chunks | 53.1 | 62.5 | 43.2 | 23.6 | 32 |
| rerank: default + cross-encoder on the top 30 | 77.3 | 89.8 | 50.4 | 39.6 | 7,147 |

- **Hybrid over either retriever alone:** fusion adds 6 points of recall@10 over dense-only and 14 over BM25-only.
- **Filters:** without them recall@10 falls 20 points, and 25 on two-company comparisons, where the question names both companies.
- **Structure-aware chunks:** fixed windows lose 32 points of recall@10.
- **No reranker:** the MS MARCO cross-encoder, trained on web search passages, lowered MRR@10 by 18 points on these filings and took about 7 s per query (Node, WASM), so the app does not download it.

Latency is measured in Node on the same WASM runtime the browser uses, one query at a time, including query embedding.

## License

[MIT](LICENSE)
