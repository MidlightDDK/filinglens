// OpenAI-compatible chat client for eval-time LLM calls (synthetic items now,
// the judge later). Every response is cached in evals/.cache/llm/ keyed by
// sha256(model | request), so reruns are free and interrupted runs resume.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { REPO_ROOT } from "@filinglens/core/node";
import { sha256 } from "./dataset.ts";

export interface Provider {
  name: string;
  url: string;
  keyEnv: string;
  rpm: number;
  tpm: number;
}

export const PROVIDERS = {
  // Free plan limits for openai/gpt-oss-120b: 30 RPM, 8K TPM, 200K TPD
  // (https://console.groq.com/docs/rate-limits).
  groq: {
    name: "groq",
    url: "https://api.groq.com/openai/v1/chat/completions",
    keyEnv: "GROQ_API_KEY",
    rpm: 30,
    tpm: 8000,
  },
} satisfies Record<string, Provider>;

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" };
  reasoning_effort?: "low" | "medium" | "high";
}

export interface ChatResult {
  content: string;
  usage: { prompt_tokens: number; completion_tokens: number };
  cached: boolean;
}

const CACHE_DIR = `${REPO_ROOT}evals/.cache/llm`;

/** Loads worker/.dev.vars (the local secrets file) without overriding the env. */
export function loadLocalEnv(): void {
  const path = `${REPO_ROOT}worker/.dev.vars`;
  if (existsSync(path)) process.loadEnvFile(path);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Refills `perMinute` units per minute, up to `perMinute`. */
export class TokenBucket {
  private level: number;
  private last: number;
  private readonly perMinute: number;
  private readonly now: () => number;

  constructor(perMinute: number, now: () => number = Date.now) {
    this.perMinute = perMinute;
    this.level = perMinute;
    this.now = now;
    this.last = now();
  }

  /** Milliseconds to wait before `n` units are available (and reserves them). */
  reserve(n: number): number {
    const t = this.now();
    this.level = Math.min(
      this.perMinute,
      this.level + ((t - this.last) / 60_000) * this.perMinute,
    );
    this.last = t;
    const need = Math.min(n, this.perMinute);
    this.level -= need;
    return this.level >= 0 ? 0 : (-this.level / this.perMinute) * 60_000;
  }
}

export class LlmClient {
  private readonly provider: Provider;
  private readonly requests: TokenBucket;
  private readonly tokens: TokenBucket;
  private readonly key: string;

  constructor(provider: Provider) {
    loadLocalEnv();
    const key = process.env[provider.keyEnv];
    if (!key) {
      throw new Error(
        `${provider.keyEnv} is not set (env or worker/.dev.vars); ` +
          `it is needed for ${provider.name} calls not already cached`,
      );
    }
    this.provider = provider;
    this.key = key;
    this.requests = new TokenBucket(provider.rpm);
    this.tokens = new TokenBucket(provider.tpm);
  }

  static cached(req: ChatRequest): ChatResult | null {
    const path = `${CACHE_DIR}/${cacheKey(req)}.json`;
    if (!existsSync(path)) return null;
    const hit = JSON.parse(readFileSync(path, "utf8")) as ChatResult;
    return { ...hit, cached: true };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const hit = LlmClient.cached(req);
    if (hit) return hit;
    const estimate =
      Math.ceil(JSON.stringify(req.messages).length / 4) +
      (req.max_tokens ?? 1024);
    for (let attempt = 0; ; attempt++) {
      await sleep(
        Math.max(this.requests.reserve(1), this.tokens.reserve(estimate)),
      );
      const res = await fetch(this.provider.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(req),
      });
      if (res.ok) {
        const body = (await res.json()) as {
          choices: { message: { content: string | null } }[];
          usage?: { prompt_tokens: number; completion_tokens: number };
        };
        const result: ChatResult = {
          content: body.choices[0]?.message.content ?? "",
          usage: body.usage ?? { prompt_tokens: 0, completion_tokens: 0 },
          cached: false,
        };
        mkdirSync(CACHE_DIR, { recursive: true });
        writeFileSync(
          `${CACHE_DIR}/${cacheKey(req)}.json`,
          `${JSON.stringify(result)}\n`,
        );
        return result;
      }
      const retryable = res.status === 429 || res.status >= 500;
      const detail = (await res.text()).slice(0, 300);
      if (!retryable || attempt >= 5) {
        throw new Error(`${this.provider.name} HTTP ${res.status}: ${detail}`);
      }
      const after = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(after) && after > 0 ? after * 1000 : 0;
      if (wait > 120_000) {
        throw new Error(
          `${this.provider.name} quota exhausted (retry in ${Math.round(wait / 60_000)} min); ` +
            "rerun later, finished calls are cached",
        );
      }
      await sleep(Math.max(wait, 2 ** attempt * 2000));
    }
  }
}

export function cacheKey(req: ChatRequest): string {
  return sha256(`${req.model}|${JSON.stringify(req)}`);
}
