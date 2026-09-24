import {
  JUDGE_VERSION,
  MARKER,
  PROMPT_VERSION,
  type Usage,
} from "@filinglens/core";
import { CHAIN_VERSION } from "./providers/providers.config";

export const CACHE_TTL_S = 7 * 24 * 60 * 60;

export interface CachedAnswer {
  answer: string;
  /** Source order the answer's `[n]` markers refer to. */
  chunkIds: string[];
  provider: string;
  model: string;
  usage: Usage | null;
}

export const normalizeQuestion = (q: string) =>
  q
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s?.!]+$/, "");

async function sha256Hex(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function cacheKey(
  configId: string,
  question: string,
  chunkIds: readonly string[],
): Promise<string> {
  return sha256Hex(
    [
      PROMPT_VERSION,
      configId,
      normalizeQuestion(question),
      [...chunkIds].sort().join(","),
      CHAIN_VERSION,
    ].join("|"),
  );
}

/** Judge verdicts depend on the exact answer and on the source order. */
export async function verifyCacheKey(
  configId: string,
  question: string,
  answer: string,
  chunkIds: readonly string[],
): Promise<string> {
  const raw = [
    JUDGE_VERSION,
    configId,
    normalizeQuestion(question),
    answer,
    chunkIds.join(","),
    CHAIN_VERSION,
  ].join("|");
  return `verify:${await sha256Hex(raw)}`;
}

/** The key ignores source order, so renumber markers for the current order. */
export function remapMarkers(
  answer: string,
  from: readonly string[],
  to: readonly string[],
): string {
  const renumber = (n: string) => {
    const id = from[Number(n) - 1];
    const m = id === undefined ? -1 : to.indexOf(id);
    return m < 0 ? n : String(m + 1);
  };
  return answer.replace(
    MARKER,
    (_, list: string) => `[${list.replace(/\d+/g, renumber)}]`,
  );
}

// KV is best effort: the free tier allows ~1k writes a day, so ignore errors.
export async function getCached<T = CachedAnswer>(
  kv: KVNamespace,
  key: string,
): Promise<T | null> {
  try {
    return await kv.get<T>(key, "json");
  } catch {
    return null;
  }
}

export async function putCached<T = CachedAnswer>(
  kv: KVNamespace,
  key: string,
  value: T,
): Promise<void> {
  try {
    await kv.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL_S });
  } catch {
    // ignored
  }
}
