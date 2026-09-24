import type { ChatMessage } from "@filinglens/core";
import type { Env } from "../env";
import { gemini, groq } from "./openaiCompat";
import {
  CHAIN,
  COLD_MS,
  FIRST_TOKEN_TIMEOUT_MS,
  type ProviderId,
} from "./providers.config";
import { type Provider, ProviderError, type ProviderEvent } from "./types";
import { workersAi } from "./workersAi";

export const PROVIDERS: Record<ProviderId, Provider> = {
  workersAi,
  groq,
  gemini,
};

/** Provider → time until which it is skipped. Per isolate, best effort. */
const coldUntil = new Map<ProviderId, number>();

export const isCold = (id: ProviderId, now = Date.now()) =>
  (coldUntil.get(id) ?? 0) > now;

export function resetCold(): void {
  coldUntil.clear();
}

export interface Attempt {
  provider: ProviderId;
  outcome: "ok" | "unconfigured" | "cold" | "forced" | "timeout" | "error";
  status?: number;
}

/** A provider that produced its first token; `rest` continues its stream. */
export interface Started {
  provider: Provider;
  first: string;
  rest: AsyncIterator<ProviderEvent>;
  abort: () => void;
  attempts: Attempt[];
}

export class AllProvidersFailed extends Error {
  readonly attempts: Attempt[];
  constructor(attempts: Attempt[]) {
    super("all providers failed");
    this.attempts = attempts;
  }
}

export interface ChainOptions {
  /** Providers to fail on purpose (dev-only `X-Debug-Fail` header). */
  forceFail?: ReadonlySet<string>;
  firstTokenMs?: number;
  providers?: Provider[];
}

const TIMEOUT = Symbol("timeout");

/**
 * Tries providers in order until one streams a first token. Falls through on
 * any error or when no first token arrives in time; 429, 5xx, network errors,
 * and timeouts also mark the provider cold for COLD_MS.
 */
export async function startChain(
  messages: ChatMessage[],
  env: Env,
  opts: ChainOptions = {},
): Promise<Started> {
  const providers = opts.providers ?? CHAIN.map((id) => PROVIDERS[id]);
  const attempts: Attempt[] = [];
  for (const provider of providers) {
    const { id } = provider;
    if (!provider.configured(env)) {
      attempts.push({ provider: id, outcome: "unconfigured" });
      continue;
    }
    if (isCold(id)) {
      attempts.push({ provider: id, outcome: "cold" });
      continue;
    }
    if (opts.forceFail?.has(id)) {
      attempts.push({ provider: id, outcome: "forced" });
      continue;
    }
    const ctrl = new AbortController();
    const it = provider
      .stream(messages, env, ctrl.signal)
      [Symbol.asyncIterator]();
    const next = it.next();
    next.catch(() => {}); // it may still reject after a timeout
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const first = await Promise.race([
        next,
        new Promise<typeof TIMEOUT>((resolve) => {
          timer = setTimeout(
            () => resolve(TIMEOUT),
            opts.firstTokenMs ?? FIRST_TOKEN_TIMEOUT_MS,
          );
        }),
      ]);
      if (first === TIMEOUT) {
        ctrl.abort();
        coldUntil.set(id, Date.now() + COLD_MS);
        attempts.push({ provider: id, outcome: "timeout" });
        continue;
      }
      if (first.done || first.value.type !== "token") {
        throw new ProviderError(502, `${id} returned an empty answer`);
      }
      attempts.push({ provider: id, outcome: "ok" });
      return {
        provider,
        first: first.value.text,
        rest: it,
        abort: () => ctrl.abort(),
        attempts,
      };
    } catch (err) {
      ctrl.abort();
      const status = err instanceof ProviderError ? err.status : 503;
      if (status === 429 || status >= 500) {
        coldUntil.set(id, Date.now() + COLD_MS);
      }
      attempts.push({ provider: id, outcome: "error", status });
    } finally {
      clearTimeout(timer);
    }
  }
  throw new AllProvidersFailed(attempts);
}

/** For `/api/health`: which providers could take a request right now. */
export function providerStatus(env: Env) {
  return CHAIN.map((id) => ({
    id,
    model: PROVIDERS[id].model,
    configured: PROVIDERS[id].configured(env),
    cold: isCold(id),
  }));
}
