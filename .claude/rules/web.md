---
paths:
  - "web/**"
---
# Web app (Vite + React + TypeScript + Tailwind)

## Routes
- `/` Ask. Six example chips (lookup, table number, comparison, trend, false premise, out-of-scope) render precomputed answers from `/examples/*.json` instantly, each with a "Run live" button; plus a free-text box.
- Answer view: streamed text; citation markers render as chips; each sentence gets a status icon with a text label (verified / unverified / unsupported; never color alone); a Sources panel with the highlighted span and an "Open on SEC.gov" link; an "Under the hood" drawer with filters, candidates and all scores, rerank moves, stage timings, provider/model, tokens, and WebGPU vs WASM.
- `/lab` Pipeline Lab: configs × metrics table from `/evals/latest.json`; pick two configs and one question → side-by-side retrieval (live) and answers (live or cached).
- `/evals`: dataset composition, metrics including judge agreement, trend across releases, failure examples with notes.
- `/about`: architecture diagram, "How this runs for $0", links to the repo and the write-up.

## Loading and performance
- First paint never waits for models or the index. After first paint, load the embedding model and the default index in a Web Worker with visible progress; rely on the Transformers.js browser cache.
- Use WebGPU when available, else WASM.
- Budget: JS ≤ 250 KB gzipped (excluding models and index); Lighthouse performance ≥ 90 on `/`; example answers render in < 300 ms.
- The build copies `evals/reports/latest.json` to `web/public/evals/latest.json` (gitignored copy).

## Security headers: `web/public/_headers`
`Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://challenges.cloudflare.com; connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co https://cdn.jsdelivr.net; frame-src https://challenges.cloudflare.com; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`. Verify once with Playwright (no violations while loading and answering), adjust, and note what changed.
- Render model output as Markdown without raw HTML; links only to sec.gov.

## Config
Public values (Turnstile site key, API base path) live in `web/src/config.ts`. They are public by design; secrets never go there.

## Tests
vitest + Testing Library for components with logic (citation chips, status labels, drawer). Playwright (chromium): example chip → answer + citation highlight; `/lab` and `/evals` render from fixtures; no console errors; no CSP violations.

