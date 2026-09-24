# FilingLens roadmap
One milestone at a time. Start each with an ≤ 8-line plan and wait for approval; end with the 5-line report. A milestone is done only when every acceptance box passes; then tick it in CLAUDE.md.

## M0: Scaffold + hello-world deploy
- If CLAUDE.md still contains the reference sections, run the first-run split.
- Workspace: pnpm workspace (`web`, `worker`, `packages/core`, `scripts`, `evals`); uv project in `pipeline/`; strict TypeScript base config; ESLint + Prettier (or Biome; pick one and note why); vitest; Playwright (chromium only); ruff + pytest.
- Files: `.gitignore` and `.claude/settings.json` exactly as below; `LICENSE` (MIT); `README.md` stub (pitch + "under construction"); `worker/dev.vars.example` (names only); root `package.json` scripts matching the Commands section (stubs printing "not implemented" are fine until their milestone).
- Worker serving a placeholder SPA page plus `GET /api/health`. `pnpm dev` runs `vite` and `wrangler dev` together with Vite proxying `/api`, or uses the Cloudflare Vite plugin; pick one and note why.
- `ci.yml`: install, lint, typecheck, unit tests, build; a Python job with ruff + pytest.
- First deploy: the user runs `wrangler login`; Claude runs `pnpm run deploy` after approval.
Acceptance:
- [ ] `https://filinglens.<account-subdomain>.workers.dev` shows the placeholder and `/api/health` returns JSON.
- [ ] CI is green on a PR.
- [ ] `git ls-files | grep -E '(^|/)(\.env|\.dev\.vars)$'` prints nothing.

`.gitignore`:
```gitignore
node_modules/
dist/
.wrangler/
coverage/
playwright-report/
test-results/
.venv/
__pycache__/
.pytest_cache/
.ruff_cache/
.env
.env.*
.dev.vars
CLAUDE.local.md
.claude/settings.local.json
HANDOFF.md
data/
web/public/index/
web/public/evals/
evals/results/
evals/.cache/
*.log
.DS_Store
```

`.claude/settings.json` (strict JSON, no comments):
```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(./**/.env)",
      "Read(./**/.env.*)",
      "Read(./**/.dev.vars)",
      "Bash(git push --force *)",
      "Bash(git push -f *)",
      "Bash(git push * --force)"
    ],
    "ask": [
      "Bash(git push)",
      "Bash(git push *)",
      "Bash(pnpm run deploy)",
      "Bash(pnpm run deploy *)",
      "Bash(npx wrangler deploy)",
      "Bash(npx wrangler deploy *)"
    ]
  }
}
```

## M1: Ingest, parse, chunk
- `corpus.yaml`, SEC client (User-Agent, rate limit, cache, manifest), parser, `fixed` and `structure` chunkers, stats output.
Acceptance:
- [ ] All 24 filings downloaded and parsed; any failure logged with its reason.
- [ ] Items 1/1A/7/7A/8 found in ≥ 95% of docs.
- [ ] pytest green on the fixtures; `pnpm data:chunk` prints stats.

## M2: Index + in-browser retrieval
- `scripts/build-index.ts`; `packages/core` retrieval (filters, lexical, dense, RRF, rerank hook); the Ask page in search-only mode showing ranked passages; model loading in a Web Worker.
Acceptance:
- [ ] Index within budget.
- [ ] Node and browser return identical top-10 ids for 5 fixture queries (automated test).
- [ ] Query → passages in < 1 s after warm-up on the user's laptop (report the measured number).
- [ ] Deployed.

## M3: Eval set v1 + retrieval evals in CI
- XBRL items; synthetic generator + review CSV flow; handwritten-item template for the user; dev/test split; retrieval runner, metrics, report; `baseline.json`; CI gate.
Acceptance:
- [ ] ≥ 150 reviewed items covering every category.
- [ ] Report for ≥ 4 configs; the default config chosen from dev metrics, with the decision recorded in README "Design decisions".
- [ ] The CI gate proven by a deliberately broken branch (then reverted).

## M4: Gateway + grounded, cited answers
- Worker endpoints, provider chain, SSE, Turnstile session, rate limits, KV cache, prompt, abstention; answer UI with citation chips and source highlighting.
Acceptance:
- [ ] Live answers stream with citations.
- [ ] Forced failure of each provider (dev-only flag) falls through correctly (tests).
- [ ] An out-of-scope question shows the insufficient-evidence UI.
- [ ] No secret values in the bundle (grep `web/dist` for key prefixes returns nothing).

## M5: Sentence verification + answer evals
- Deterministic verifier; optional judge endpoint; sentence status UI; `judge_labels.jsonl` calibration report; answers runner; PR comment.
Acceptance:
- [ ] Judge agreement reported (target ≥ 85%; if lower, iterate on the rubric and report honestly).
- [ ] Answer metrics on dev in `latest.json`.
- [ ] The UI shows sentence statuses.

## M6: Pipeline Lab, Evals page, examples
- `pnpm examples` (precompute the six example answers with full metadata; committed), `/lab`, `/evals`, and the "Under the hood" drawer.
Acceptance:
- [ ] Example chips are instant and work even when every provider is down.
- [ ] `/lab` compares two configs live.
- [ ] `/evals` shows the dataset, metrics, and judge agreement.

## M7: Polish + launch
- README (outline below), architecture diagram (Mermaid in the README), performance-budget and mobile pass, `smoke.yml`, release eval on the test split, final numbers in the README.
Acceptance:
- [ ] README complete; test-split release numbers committed.
- [ ] Smoke workflow green for 3 consecutive days.
- [ ] Demo video (recorded by the user) linked at the top of the README.

## Stretch (only when the user asks)
`contextual` chunking variant; an MCP server exposing `search_filings` and `get_passage`; an in-browser fallback LLM for when every provider quota is spent.

## README outline (recruiter-first)
1. One-line pitch, live link, 60-second video/GIF.
2. Results table (test split): recall@10, answer accuracy, citation coverage, verified-sentence rate, abstention F1, judge agreement, p50 latency.
3. How it works (diagram) and a "Runs for $0" box.
4. Design decisions and tradeoffs, each with its eval evidence.
5. What didn't work.
6. Eval methodology.
7. Run locally.
8. Data sources, terms, limitations.
