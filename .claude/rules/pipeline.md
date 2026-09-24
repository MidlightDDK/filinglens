---
paths:
  - "pipeline/**"
---
# Pipeline spec (Python 3.12, uv). Offline only.

## Corpus: `pipeline/config/corpus.yaml`
- Default: NVDA, AMD, INTC, AAPL, MSFT, GOOGL, AMZN, META, NFLX, KO, PEP, JPM × the latest 2 fiscal-year 10-K filings. The user may edit the list.
- Resolve CIKs at runtime from SEC's `company_tickers.json`; never hardcode CIKs from memory.
- Keep Items 1, 1A, 7, 7A, 8 only (index-size budget).

## SEC access
- Every request sends `User-Agent: $SEC_USER_AGENT`; fail fast if it is unset. Stay at ≤ 5 requests/second (SEC's fair-access cap is 10) and retry with backoff on 429/5xx.
- Filings list: `https://data.sec.gov/submissions/CIK{cik:010d}.json`. Document: `https://www.sec.gov/Archives/edgar/data/{cik}/{accession_without_dashes}/{primaryDocument}`. XBRL facts: `https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json`.
- Cache downloads in `data/raw/` (gitignored), skip existing files, and write `data/raw/manifest.json` (ticker, cik, fy, accession, url, sha256).

## Parse → `data/processed/`
- `doc_id` = `{TICKER}-FY{fy}`. Store normalized plain text per doc in `text/{doc_id}.txt`. All offsets (blocks, chunks, citations, gold spans) are character offsets into this file, so labels survive any rechunking.
- Blocks go to `blocks/{doc_id}.jsonl`: `{block_id, item, heading_path[], type: heading|paragraph|table, char_start, char_end}`.
- Find Item boundaries with a heading regex and skip the table-of-contents occurrence. Drop hidden iXBRL content, page headers and footers, and page numbers.
- Convert tables to Markdown with a header row, and carry the unit line ("in millions, except per share data") into the table text.
- Tests use small hand-written HTML fixtures in `pipeline/tests/fixtures/`, never full filings.

## Chunkers → `data/processed/chunks/{strategy}.jsonl`
- Chunk: `{chunk_id, doc_id, strategy, item, heading_path, char_start, char_end, n_tokens, text}`. `n_tokens` comes from the embedding model's tokenizer (see the retrieval rule).
- `fixed`: 350-token windows, 50-token overlap, structure-blind (the baseline).
- `structure`: split at headings. Keep tables whole up to 600 tokens; split larger tables by row groups and repeat the header row. Prefix each chunk with `{Company} FY{fy} 10-K | Item {n} {title} | {heading}`.
- Stretch only: `contextual` (structure plus 1–2 LLM-written context sentences per chunk), generated in batch on a Kaggle GPU with an open-weight model, never through the live gateway.
- `pnpm data:chunk` prints stats: chunks per doc, token-length p50/p95, and % table chunks.

## XBRL numeric items → `evals/datasets/xbrl_numeric.jsonl`
- Concepts, with per-company variants mapped: revenue (`Revenues` | `RevenueFromContractWithCustomerExcludingAssessedTax`), `NetIncomeLoss`, `ResearchAndDevelopmentExpense`, `OperatingIncomeLoss`, `EarningsPerShareDiluted`, `CashAndCashEquivalentsAtCarryingValue`.
- Take facts with `form == "10-K"`, `fp == "FY"`, and `end` equal to that filing's fiscal-year end; dedupe by accession. Prior-year comparative values in the same filing must never be mistaken for the current year.
- Templates: single value, year-over-year change, ratio (e.g. R&D / revenue), two-company comparison.
- Gold spans: search the doc text for the value in common formats (60,922 · 60.9 billion · $60,922). If it isn't found, keep the item for answer scoring with `gold_spans: []`.

