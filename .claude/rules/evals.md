---
paths:
  - "evals/**"
  - ".github/**"
---
# Evals + CI

## Datasets (`evals/datasets/`, JSONL, committed, stable ids)
- `golden.jsonl`: `{id, question, category, companies[], fiscal_years[], answerable, gold_answer, gold_numeric?: {value, unit, tolerance}, gold_spans: [{doc_id, char_start, char_end, group?}], source: xbrl|synthetic_reviewed|handwritten, split: dev|test}`. `tolerance` is absolute, in `unit`. Spans sharing a `group` are interchangeable evidence for one fact (a span without one is its own group); recall counts groups.
- Categories: lookup, table_number, comparison, trend, multi_hop, false_premise, unanswerable. Target 200 items with ≥ 20 per category; split dev/test 60/40, stratified. The test split runs only for release numbers.
- Sources: XBRL numeric items (pipeline); synthetic items (an LLM proposes Q/A plus evidence from sampled chunks → the user reviews `evals/review/queue.csv` with accept/edit/reject → an import script); ≥ 30 handwritten hard items (false premise, unanswerable, multi-hop) written by the user.
- `judge_labels.jsonl`: ≥ 50 `(question, answer, human_label, rationale)` rows for judge calibration.
- Gold spans are character offsets into `data/processed/text/{doc_id}.txt`, so they are chunking-independent. A retrieved chunk is relevant if it overlaps a gold span by ≥ 30 characters. `evals/datasets/text_hashes.json` records each text's sha256; the runner refuses to score if a text changed.

## Metrics
- Retrieval (no LLM): recall@5, recall@10, MRR@10, nDCG@10, per config and per category.
- Answers: numeric exact match within tolerance; LLM-judge correctness (binary, with a rubric) for non-numeric items; citation coverage (% of sentences with ≥ 1 valid citation); citation precision (cited chunk overlaps gold or passes the judge's support check); verified-sentence rate; abstention precision/recall on unanswerable items; false-premise correction rate.
- Judge quality: agreement % and Cohen's kappa vs `judge_labels.jsonl`. Re-run whenever the judge prompt or model changes, and report it next to every judged metric.
- Operations: p50/p95 latency per stage, tokens in/out, provider mix.

## Runners (TypeScript in `evals/src/`, importing `packages/core`, the production code path)
- `pnpm eval:retrieval --config <id|all> --split dev` → `evals/results/<ts>/retrieval.jsonl` + `summary.json`.
- `pnpm eval:answers --split dev --limit N`: generation calls providers directly (`GROQ_API_KEY`, the Worker's Groq model and parameters). The judge runs on Groq (`qwen/qwen3.8-27b`, the Worker's judge model; `pnpm eval:judge` calibrates it). GitHub Models is not an option: on 2026-09-24 its catalog and inference endpoints answered every request with a bare `200 OK`. The judge model must differ from the generator model.
- Groq's free tier allows 200K tokens/day per model (~2.5K per answer), so `--limit N` takes a stratified subset whose smaller limits are subsets of larger ones; runs stop with exit code 3 on quota and resume from the cache.
- Cache every LLM call in `evals/.cache/` keyed by sha256(model | prompt), so reruns are free and reproducible. Use a token-bucket limiter per provider and make runs resumable.
- Reports: `evals/reports/latest.json` (plus dated copies on release) for the web app, and a Markdown table for PR comments.

## CI (`.github/workflows/`)
- `ci.yml` (PRs and main): pnpm lint/typecheck/test, ruff + pytest, build, Playwright (chromium). Then the retrieval eval on dev for the `default` config using a cached index (actions/cache keyed by a hash of pipeline code + config; SEC raw data cached too; rebuild on a miss). Gate: fail if recall@10 drops by > 2 points vs `evals/baseline.json`. If secrets are available: the answers eval on 20 dev items, gated on numeric EM and citation coverage. Post the metrics table as a PR comment (`gh pr comment`, `permissions: pull-requests: write`).
- `eval.yml` (workflow_dispatch): full dev or test run; upload results as an artifact; with `release: true`, commit `evals/reports/<date>.json` and `latest.json`.
- `deploy.yml` (push to main): build index (cached) → build web → `wrangler deploy` using `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- `smoke.yml` (daily cron): load `/`, call `/api/health`, open one example; open an issue on failure.
- Least-privilege `permissions` per job. Forks get no secrets, so skip LLM steps when secrets are absent.

