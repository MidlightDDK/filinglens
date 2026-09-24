# FilingLens

Citation-verified Q&A over SEC 10-K filings. Ask a question about the annual reports of about 12 public companies. Every sentence in the answer cites its source passage, sentences that can't be verified are flagged, and questions the filings can't answer are declined.

> **Under construction.** The live demo, eval results, and setup instructions will appear here as milestones land.

## Data sources and terms

| Source | Used for | Terms |
| --- | --- | --- |
| [SEC EDGAR](https://www.sec.gov/edgar): `company_tickers.json`, the submissions API, and 10-K primary documents | The filings corpus (`pipeline/config/corpus.yaml`) | U.S. government public data. Downloads follow the [fair-access policy](https://www.sec.gov/os/accessing-edgar-data): a declared User-Agent, at most 5 requests per second (the cap is 10), and a local cache so each file is fetched only once. |
| [`Xenova/bge-small-en-v1.5`](https://huggingface.co/Xenova/bge-small-en-v1.5) `tokenizer.json`, pinned revision `ea104dac` | Chunk token counts; passage and query embeddings (`onnx/model_quantized.onnx`, q8), in Node at index time and in your browser at query time | ONNX conversion of [`BAAI/bge-small-en-v1.5`](https://huggingface.co/BAAI/bge-small-en-v1.5) (MIT). The browser downloads it from huggingface.co. |
| [onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web) WASM via [jsDelivr](https://www.jsdelivr.com/terms) | Running the embedding model in the browser | MIT; Transformers.js loads it from cdn.jsdelivr.net. |

Raw filings and processed text live in `data/` and are not committed. Run `pnpm data:ingest` (needs `SEC_USER_AGENT="Full Name email@example.com"`), then `pnpm data:chunk`. `pnpm index` then builds the search index into `web/public/index/` (also not committed).

## Design decisions

- **Biome instead of ESLint + Prettier:** one dependency and one config handle both linting and formatting, and it runs much faster. It is set to Prettier's default output style.
- **Vite dev proxy instead of the Cloudflare Vite plugin:** `pnpm dev` runs `vite` and `wrangler dev` side by side, and Vite forwards `/api` to the Worker. This keeps a single deploy path (`wrangler deploy` in `worker/` serving `web/dist`). The plugin would replace the build output and deploy config with its own layout.
- **Custom BM25 instead of MiniSearch:** the lexical index is a compact term → postings map with deterministic output and no dependency, and one tokenizer (`packages/core/src/lexical.ts`) runs at build time and query time.
- **q8 embeddings everywhere:** Node and the browser run the same quantized ONNX file (34 MB instead of 133 MB), so indexed and query vectors come from the same weights.
- **Queries in Node use the browser's WASM runtime:** onnxruntime-node's x86 int8 kernels give slightly different vectors than WASM (cosine ~0.998 on some inputs), enough to reorder close results. Evals and the parity test embed queries with onnxruntime-web, so Node and the browser return identical rankings. Passages are embedded once at index time with the ~10x faster onnxruntime-node.

## License

[MIT](LICENSE)
