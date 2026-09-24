<!--
FilingLens: single-file brief for Claude Code.
Setup (human): create an empty PUBLIC GitHub repo named filinglens, clone it, save this file as CLAUDE.md
in the repo root, start Claude Code there and say: Start M0.
On the first run Claude splits this file with one awk command. The part before the first split marker stays
in CLAUDE.md (loaded every session, under 200 lines). Each later section moves to .claude/rules/ (loaded only
when Claude reads matching files) or docs/ (read on demand). HTML comments like this one are stripped from
Claude's context, so they cost no tokens.
-->
# FilingLens: citation-verified Q&A over SEC 10-K filings

## Mission
AI Engineer portfolio project. A recruiter opens a public URL and, with no login or setup, asks questions about the 10-K annual reports of ~12 public companies. Every answer sentence cites its source (click → exact passage highlighted), sentences that can't be verified are flagged, questions the filings can't answer are declined, and a Pipeline Lab shows how retrieval choices change measured quality. The goal is proof: real eval numbers, grounded answers, and a demo that works on the first click.

## Hard constraints (never violate)
- $0 at every stage: dev, CI, hosting, inference. Only free tiers that need no payment method. If anything would need a card or a paid plan, stop and ask.
- Public repo: never commit secrets, personal data (including the SEC contact email), build outputs, or large binaries. Data is public; record every source and its terms in the README.
- Recruiter-first: live URL, no login; example questions answer instantly from precomputed files; usable on mobile; a friendly message (not an error) when free quotas run out.
- Every number shown in the UI or README comes from a reproducible eval run.
- Evals exercise the production code (`packages/core`), never a re-implementation.

## Token efficiency rules
Apply to every task. Aim: a correct result using the least context and output. Never trade away correctness, or verification the task genuinely needs, to save tokens.

### Scope
- Do exactly what was asked. No unrequested refactors, renames, reformatting, dependency changes, or extra features; mention other problems you notice in one line instead.
- Ambiguous request: ask one focused question before starting. Large change (many files or an architectural choice): outline the plan in 8 lines or fewer and wait for approval, unless a plan was already approved or the user asked you to proceed on your own.
- `docs/ROADMAP.md` is approved at milestone level only. At the start of each milestone, read only that milestone's section (`grep -n '^## ' docs/ROADMAP.md`, then read that range), post an ≤8-line plan, and wait for approval.

### Reading and searching
- Locate before reading: Grep/Glob (or the LSP tool if available), then Read only the relevant range. Check length (`wc -l`) before opening an unfamiliar file; for files over ~300 lines, read only the ranges you need.
- Don't re-read files already in context unless they changed or you only saw part of them.
- Put independent searches and reads in the same turn (parallel tool calls).
- Never scan the whole repo (`ls -R`, `tree`, unscoped `find` or grep). Scope to the relevant directory.
- Don't open unless the task requires it: `.git/`, `node_modules/`, `web/dist/`, `.wrangler/`, `.venv/`, `__pycache__/`, `.pytest_cache/`, `.ruff_cache/`, `coverage/`, `playwright-report/`, `test-results/`, lockfiles (`pnpm-lock.yaml`, `uv.lock`), minified bundles, source maps, generated code, snapshots, `data/` (raw filings, processed JSONL), `web/public/index/`, `web/public/examples/`, `evals/results/`, `evals/.cache/`, binaries, media. If one is needed, inspect its shape first (`head -c 500`, `wc -l`, `jq 'keys'`, a targeted grep).
- Prefer the repo over the web. Search or fetch only when the answer isn't local, and fetch the specific page, not the whole site. Record what you looked up (endpoint, model ID, flag) where it is used, as a config value or a one-line comment with the doc URL, so it's never looked up twice.

### Commands
- Keep output short: quiet/summary flags (`pnpm -s`, `-q`, `--silent`, `--oneline`, `--stat`, `-n 20`) and filters (`| tail -n 40`, `| grep -iE "error|fail"`).
- Narrowest check first: one test file or test name (`pnpm vitest run packages/core/src/rrf.test.ts -t "ties"`, `uv run --project pipeline pytest pipeline/tests/test_sections.py -q -k item7`). Widen to the full suite only when the targeted check passes or the change is broad.
- Send long output (builds, logs, full suites, eval runs) to a file and grep it: `pnpm build > /tmp/build.log 2>&1; grep -iE "error|warn" /tmp/build.log | head -n 30`.
- Don't re-run a command whose result was already clear.
- When a CLI and an MCP tool do the same job (e.g. `gh` vs a GitHub MCP server), use the CLI.

### Editing
- Edit only the lines that change; don't rewrite whole files for small changes.
- Don't create files nobody asked for (summaries, reports, extra docs/READMEs, examples, scratch scripts); files named in this spec count as asked for. Delete temp files you create.
- Add comments, docstrings, or logging only when asked or when essential.

### Replies
- Lead with the result. No preamble, no restating the request, no step-by-step narration.
- Reference code as `path:line` instead of pasting what's already in files. Show a snippet only when asked or when the snippet is the answer.
- Finish with at most 5 lines: what changed, how it was verified, what's still open.
- Explain only what isn't obvious. Match reasoning depth to the difficulty of the step.
- Skip task lists for short tasks; update them only at milestones.

### When stuck
- Same approach failed twice: stop. Report what you tried, the evidence, and your best hypothesis, then propose one different approach or ask.
- Don't guess repeatedly at APIs, flags, or config; look them up once.
- If you catch yourself re-reading the same files or cycling between fixes, stop and summarize.

### Subagents and parallel work
- Use a subagent only to keep bulk out of this conversation: wide multi-directory searches, verbose test/build runs, log analysis, full eval runs. Never for single-file lookups.
- Brief subagents precisely and ask for a short report (about 150 words plus `path:line` references), not raw output.
- Don't launch agent teams, workflows, or many parallel agents unless asked.

### Session hygiene
- If the user starts an unrelated task in a long session, suggest `/clear` in one line, then proceed.
- When asked for a handoff (or before a `/clear`), write `HANDOFF.md` (gitignored) in 40 lines or fewer: goal, current state, key files, decisions, failed approaches (one line each), verification commands, next step.

### Compact instructions
When compacting, keep: the goal, current milestone, decisions and constraints, files changed, unresolved errors (exact text), test and eval commands, latest eval numbers, next steps. Drop: dead ends, file contents, passing test output, superseded plans.

## Repo map
- `pipeline/`: Python 3.12 (uv). SEC download → parse → chunk; XBRL → numeric eval items. Offline only.
- `packages/core/`: TypeScript shared by web, worker, and evals: retrieval, prompt, citations, verification.
- `scripts/`: TS build scripts (`build-index.ts`, `precompute-examples.ts`).
- `web/`: Vite + React + TS + Tailwind SPA. Retrieval runs here, in a Web Worker.
- `worker/`: Cloudflare Worker. Serves `web/dist` and `/api/*` (LLM gateway, Turnstile, rate limits, KV cache).
- `evals/`: datasets, configs, runners (TS), reports; `evals/review/` holds CSVs for human review.
- `.github/workflows/`: `ci.yml`, `eval.yml`, `deploy.yml`, `smoke.yml`.
- `.claude/rules/`: path-scoped specs. `docs/ROADMAP.md`: milestones and acceptance criteria.

## Commands (create these scripts in M0; keep the names stable)
- Setup: `pnpm i` · `uv sync --project pipeline`
- Dev: `pnpm dev` (Vite + `wrangler dev`, `/api` proxied)
- Data: `pnpm data:ingest` · `pnpm data:chunk` (wrap `uv run --project pipeline python -m pipeline.<step>`; ingest needs `SEC_USER_AGENT`)
- Index and examples: `pnpm index` · `pnpm examples`
- JS checks: `pnpm -s lint` · `pnpm -s typecheck` · `pnpm -s test` · `pnpm -s e2e`
- Python checks: `uv run --project pipeline ruff check -q` · `uv run --project pipeline pytest -q`
- Evals: `pnpm eval:retrieval --config default --split dev` (no LLM calls) · `pnpm eval:answers --split dev --limit 20`
- Build and deploy: `pnpm build` · `pnpm run deploy` (needs user confirmation; runs `wrangler deploy` in `worker/`)

## Conventions
- TypeScript strict, ESM, Prettier defaults. Python 3.12 with type hints, `ruff format` + `ruff check`.
- Pin exact versions of runtime-critical libraries (Transformers.js) and model revisions. New dependencies only when this spec names them or they replace substantial code; say why in the PR.
- One branch per milestone task (e.g. `m2-retrieval`), Conventional Commits, PR to `main`; CI green before merge.
- Tests live next to code (`*.test.ts`) or in `pipeline/tests/`.

## Secrets & safety
- Secrets live only in `worker/.dev.vars` (local, gitignored, read-denied), in Worker secrets (`wrangler secret put NAME`, run by the user), and in GitHub Actions secrets. Commit `worker/dev.vars.example` with names only.
- Names: `GROQ_API_KEY`, `GEMINI_API_KEY`, `TURNSTILE_SECRET_KEY`, `SESSION_HMAC_SECRET`; CI adds `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SEC_USER_AGENT`. Workers AI uses the `AI` binding (no key). The Turnstile site key is public and lives in `web/src/config.ts`.
- Never read, print, echo, or paste secret values into code, tests, logs, or replies. If a secret shows up in a diff or output: stop and tell the user to rotate it.
- Everything under `web/` ships to browsers and is public: no secrets or privileged logic there.
- `git push` and deploys need the user's confirmation (enforced in `.claude/settings.json`).

## Human-only steps (stop, give exact instructions, wait)
- Create free accounts without a card: Cloudflare, Groq, Google AI Studio. Create the Turnstile widget, run `wrangler login` and `wrangler secret put …`, add GitHub Actions secrets.
- Set `SEC_USER_AGENT` ("Full Name email@example.com") in the local shell and as a GitHub secret.
- Review synthetic eval items, write the hard handwritten items, label the judge-calibration set.
- Record the 60-second demo video; approve the final README.

## Where the details live
- `.claude/rules/pipeline.md` (pipeline/**) · `retrieval.md` (packages/core/**, scripts/**) · `gateway.md` (worker/**) · `web.md` (web/**) · `evals.md` (evals/**, .github/**). They load automatically when you read matching files. Before creating the first file in an area, read its rule file directly.
- `docs/ROADMAP.md`: milestones, acceptance criteria, M0 file templates, README outline.

## Milestone status (tick only when every acceptance box for that milestone passes)
- [x] M0 Scaffold + hello-world deploy
- [x] M1 Ingest, parse, chunk
- [x] M2 Index + in-browser retrieval
- [x] M3 Eval set v1 + retrieval evals in CI
- [x] M4 Gateway + grounded, cited answers
- [ ] M5 Sentence verification + answer evals
- [ ] M6 Pipeline Lab, Evals page, examples
- [ ] M7 Polish + launch

