/** The subset of the Workers AI binding the gateway uses. */
export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export interface Env {
  ASSETS: Fetcher;
  AI: AiBinding;
  ANSWER_CACHE: KVNamespace;
  RL_ANSWER: RateLimit;
  RL_OTHER: RateLimit;
  GROQ_API_KEY?: string;
  GEMINI_API_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  SESSION_HMAC_SECRET?: string;
  /** "1" only in local dev (`pnpm dev`): enables the X-Debug-Fail header. */
  DEV_FLAGS?: string;
}
