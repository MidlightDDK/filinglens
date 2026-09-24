import { parseSSE, type Usage } from "@filinglens/core";
import { WORKERS_AI } from "./providers.config";
import { type Provider, ProviderError, toUsage } from "./types";

/** Workers AI through the `AI` binding (no key). */
export const workersAi: Provider = {
  id: "workersAi",
  model: WORKERS_AI.model,
  configured: (env) => Boolean(env.AI),
  async *stream(messages, env, signal) {
    let body: unknown;
    try {
      body = await env.AI.run(WORKERS_AI.model, {
        messages,
        stream: true,
        max_tokens: WORKERS_AI.max_tokens,
        temperature: 0,
      });
    } catch (err) {
      // Binding errors carry no status (e.g. "3036: daily neuron limit").
      throw new ProviderError(503, String(err));
    }
    if (!(body instanceof ReadableStream)) {
      throw new ProviderError(502, "Workers AI returned no stream");
    }
    let usage: Usage | null = null;
    for await (const ev of parseSSE(body)) {
      if (signal.aborted) return;
      if (ev.data === "[DONE]") break;
      const chunk = JSON.parse(ev.data) as {
        response?: unknown;
        choices?: { delta?: { content?: string | null } }[];
        usage?: unknown;
      };
      usage = toUsage(chunk.usage) ?? usage;
      // Chunks carry OpenAI-style deltas and a legacy `response` field, which
      // turns numeric tokens into JSON numbers (" 2025" → 2025, "0" → 0) and
      // loses spaces and zeros; use it only when it is the sole, string field.
      const delta = chunk.choices?.[0]?.delta?.content;
      const text =
        typeof delta === "string"
          ? delta
          : typeof chunk.response === "string"
            ? chunk.response
            : "";
      if (text) yield { type: "token", text };
    }
    yield { type: "done", usage };
  },
};
