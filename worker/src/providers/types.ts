import type { ChatMessage, Usage } from "@filinglens/core";
import type { Env } from "../env";
import type { ProviderId } from "./providers.config";

/** What every adapter normalizes its stream to. */
export type ProviderEvent =
  | { type: "token"; text: string }
  | { type: "done"; usage: Usage | null };

export interface Provider {
  id: ProviderId;
  model: string;
  /** Key or binding present. */
  configured(env: Env): boolean;
  /** Streams tokens (never empty ones), then exactly one `done`. */
  stream(
    messages: ChatMessage[],
    env: Env,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent>;
}

/** An upstream failure; `status` is the HTTP status, or 503 for binding errors. */
export class ProviderError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function toUsage(u: unknown): Usage | null {
  const { prompt_tokens, completion_tokens } = (u ?? {}) as Partial<Usage>;
  return typeof prompt_tokens === "number" &&
    typeof completion_tokens === "number"
    ? { prompt_tokens, completion_tokens }
    : null;
}
