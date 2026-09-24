---
paths:
  - "worker/**"
---
# Worker + LLM gateway (Cloudflare Workers, TypeScript)

## Platform facts (Workers Free) that shape the design
- 100k requests/day; 10 ms CPU per request (time spent awaiting fetch doesn't count); 50 subrequests per request; 3 MB script. Keep the Worker thin: validate → limit → load chunk shards → build prompt → stream.
- One Worker serves the SPA: `assets.directory "../web/dist"`, `not_found_handling "single-page-application"`, `binding "ASSETS"`, `run_worker_first ["/api/*"]` (needs Wrangler ≥ 4.20). Each asset file < 25 MiB.
- The Cache API is a no-op on `*.workers.dev`, so cache in Workers KV (free tier ≈ 100k reads and 1k writes per day; catch and ignore write errors).
- Workers AI goes through binding `AI` (no key; 10k free neurons/day shared by all models). Providers retire models, so model IDs live only in `providers.config.ts`.

## `worker/wrangler.jsonc`
`name`, `main: src/index.ts`, `compatibility_date` = the creation day, assets as above, `ai: {binding: "AI"}`, `kv_namespaces: [ANSWER_CACHE]`, and `ratelimits`: `RL_ANSWER` (6 per 60 s) and `RL_OTHER` (30 per 60 s). The rate-limit binding counts per Cloudflare location and is approximate, which is fine here.

## API (zod-validated JSON, body ≤ 16 KB, same-origin only via an Origin check)
- `POST /api/session {turnstileToken}` → verify with Turnstile → HMAC-signed session (30 min) in an HttpOnly, Secure, SameSite=Strict cookie.
- `POST /api/answer {question ≤ 500 chars, chunkIds ≤ 10, configId}` → SSE. The Worker loads chunk text itself via `env.ASSETS` (never trusts client-sent text), builds the prompt, streams `token` events, then sends `done {provider, model, promptVersion, usage, latencyMs, cached}`.
- `POST /api/verify {question, answer, chunkIds}` → optional judge pass, with the same limits.
- `GET /api/health` → which providers are currently usable; never secrets.

## Provider chain (`worker/src/providers/`)
- Order: `workersAi` → `groq` → `gemini`. Each adapter builds the request, streams, and normalizes to `{type: "token"|"done"|"error", ...}`.
- Fall through on 429, on 5xx, or when no first token arrives within 8 s; mark that provider cold for 60 s (in-memory, best effort). If all fail → `503 {reason: "quota"}`, and the UI points to the examples and the demo video.
- Call Groq and Gemini through their OpenAI-compatible chat-completions endpoints. Look up the base URLs and free-tier model IDs once and record them with doc URLs in `providers.config.ts`.
- `temperature 0`, `max_tokens 400`.
- Log only `{route, provider, status, latencyMs, tokens}`; never question text next to an IP.

## Caching and abuse control
- A valid session is required for `/api/answer` and `/api/verify`; rate-limit on `CF-Connecting-IP`.
- KV key = sha256(PROMPT_VERSION | configId | normalized question | sorted chunkIds | provider-chain version); TTL 7 days; store the final answer plus metadata.
- Example answers are static files and never touch the gateway.

## Tests (vitest; mock fetch and bindings)
Fallback order and cold marking, SSE normalization per provider, session and Turnstile paths, Origin rejection, oversize body, rate-limit 429, cache hit/miss.

