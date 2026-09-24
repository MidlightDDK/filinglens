import { parseSSE, type Usage } from "@filinglens/core";
import type { Env } from "../env";
import {
  GEMINI,
  GROQ,
  type OpenAiCompatible,
  type ProviderId,
} from "./providers.config";
import { type Provider, ProviderError, toUsage } from "./types";

/** A provider behind an OpenAI-compatible chat-completions endpoint. */
function openAiCompatible(
  id: ProviderId,
  cfg: OpenAiCompatible,
  key: (env: Env) => string | undefined,
): Provider {
  return {
    id,
    model: cfg.model,
    configured: (env) => Boolean(key(env)),
    async *stream(messages, env, signal) {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key(env)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          temperature: 0,
          max_tokens: cfg.max_tokens,
          ...cfg.extra,
        }),
        signal,
      }).catch((err: unknown) => {
        throw new ProviderError(503, `${id} fetch failed: ${String(err)}`);
      });
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        throw new ProviderError(res.status, `${id} HTTP ${res.status}`);
      }
      let usage: Usage | null = null;
      for await (const ev of parseSSE(res.body)) {
        if (ev.data === "[DONE]") break;
        const chunk = JSON.parse(ev.data) as {
          choices?: { delta?: { content?: string | null } }[];
          usage?: unknown;
          x_groq?: { usage?: unknown };
          error?: { message?: string };
        };
        if (chunk.error) {
          throw new ProviderError(502, `${id}: ${chunk.error.message}`);
        }
        usage = toUsage(chunk.usage ?? chunk.x_groq?.usage) ?? usage;
        const text = chunk.choices?.[0]?.delta?.content;
        if (text) yield { type: "token", text };
      }
      yield { type: "done", usage };
    },
  };
}

export const groq = openAiCompatible("groq", GROQ, (env) => env.GROQ_API_KEY);
export const gemini = openAiCompatible(
  "gemini",
  GEMINI,
  (env) => env.GEMINI_API_KEY,
);
