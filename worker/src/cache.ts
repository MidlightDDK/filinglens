import { PROMPT_VERSION, type Usage } from "@filinglens/core";
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

export async function cacheKey(
  configId: string,
  question: string,
  chunkIds: readonly string[],
): Promise<string> {
  const raw = [
    PROMPT_VERSION,
    configId,
    normalizeQuestion(question),
    [...chunkIds].sort().join(","),
    CHAIN_VERSION,
  ].join("|");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
    /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g,
    (_, list: string) => `[${list.replace(/\d+/g, renumber)}]`,
  );
}

// KV is best effort: the free tier allows ~1k writes a day, so ignore errors.
export async function getCached(
  kv: KVNamespace,
  key: string,
): Promise<CachedAnswer | null> {
  try {
    return await kv.get<CachedAnswer>(key, "json");
  } catch {
    return null;
  }
}

export async function putCached(
  kv: KVNamespace,
  key: string,
  value: CachedAnswer,
): Promise<void> {
  try {
    await kv.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL_S });
  } catch {
    // ignored
  }
}
