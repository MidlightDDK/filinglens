// The only place model IDs live: providers retire models, so change them here
// and bump CHAIN_VERSION (it is part of the answer cache key).

export const CHAIN_VERSION = "chain-v1";

/** Visible answer budget (the prompt asks for at most 180 words). */
export const ANSWER_MAX_TOKENS = 400;
/** Fall through when no first token arrives within this time. */
export const FIRST_TOKEN_TIMEOUT_MS = 8_000;
/** How long a failing provider is skipped (per isolate, best effort). */
export const COLD_MS = 60_000;

export type ProviderId = "workersAi" | "groq" | "gemini" | "groqJudge";

/** Fallback order. */
export const CHAIN: ProviderId[] = ["workersAi", "groq", "gemini"];

/**
 * The support judge (`/api/verify`). Its first model differs from every
 * answer model, and the eval runners calibrate it against human labels.
 */
export const JUDGE_CHAIN: ProviderId[] = ["groqJudge", "workersAi"];

export const WORKERS_AI = {
  // https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/
  // 26,668 / 204,805 neurons per M input / output tokens: ~140 neurons for a
  // ~3K-token prompt, so ~70 answers of the 10k free neurons per day
  // (https://developers.cloudflare.com/workers-ai/platform/pricing/).
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  max_tokens: ANSWER_MAX_TOKENS,
};

export interface OpenAiCompatible {
  url: string;
  model: string;
  /** Reasoning models count thinking tokens against max_tokens. */
  max_tokens: number;
  extra: Record<string, unknown>;
}

export const GROQ: OpenAiCompatible = {
  // https://console.groq.com/docs/rate-limits (free: 30 RPM, 8K TPM, 200K TPD;
  // the free plan lists only gpt-oss and qwen chat models).
  url: "https://api.groq.com/openai/v1/chat/completions",
  model: "openai/gpt-oss-120b",
  max_tokens: ANSWER_MAX_TOKENS + 800,
  extra: { reasoning_effort: "low", include_reasoning: false },
};

export const GEMINI: OpenAiCompatible = {
  // https://ai.google.dev/gemini-api/docs/openai (OpenAI-compatible endpoint);
  // free tier per https://ai.google.dev/gemini-api/docs/pricing.
  url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  model: "gemini-3.5-flash-lite",
  max_tokens: ANSWER_MAX_TOKENS + 800,
  extra: { reasoning_effort: "low" },
};

export const GROQ_JUDGE: OpenAiCompatible = {
  // Groq free plan, 2026-09-24: 30 RPM, 8K TPM, 200K TPD, a separate budget
  // from gpt-oss-120b (https://console.groq.com/docs/rate-limits).
  url: GROQ.url,
  model: "qwen/qwen3.8-27b",
  max_tokens: 600,
  extra: { reasoning_effort: "none" },
};
