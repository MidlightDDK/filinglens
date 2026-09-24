import {
  ChunkStore,
  type Docs,
  type IndexSource,
  type PromptSource,
  type RetrievalConfig,
} from "@filinglens/core";
import defaultConfig from "../../evals/configs/default.json";
import denseOnly from "../../evals/configs/dense-only.json";
import fixed from "../../evals/configs/fixed.json";
import lexicalOnly from "../../evals/configs/lexical-only.json";
import noFilters from "../../evals/configs/no-filters.json";
import rerank from "../../evals/configs/rerank.json";
import type { Env } from "./env";
import { HttpError } from "./http";

const CONFIGS = new Map<string, RetrievalConfig>(
  [defaultConfig, denseOnly, fixed, lexicalOnly, noFilters, rerank].map((c) => [
    c.id,
    c as RetrievalConfig,
  ]),
);

export function strategyFor(configId: string): string {
  const config = CONFIGS.get(configId);
  if (!config) throw new HttpError(400, "invalid");
  return config.strategy;
}

/** Reads the static index (`web/dist/index/...`) through the ASSETS binding. */
function assetSource(env: Env): IndexSource {
  const get = async (path: string) => {
    const res = await env.ASSETS.fetch(`https://assets.local/index/${path}`);
    if (!res.ok) throw new HttpError(400, "invalid");
    return res;
  };
  return {
    json: async <T>(path: string) => (await get(path)).json() as Promise<T>,
    bytes: async (path: string) => (await get(path)).arrayBuffer(),
  };
}

/** docs.json never changes within a deployment, so keep it per isolate. */
const docsCache = new Map<string, Promise<Docs>>();

/** Loads chunk text itself: the client only sends ids, never text. */
export async function loadSources(
  env: Env,
  strategy: string,
  chunkIds: string[],
): Promise<PromptSource[]> {
  const source = assetSource(env);
  let docsP = docsCache.get(strategy);
  if (!docsP) {
    docsP = source.json<Docs>(`${strategy}/docs.json`);
    docsP.catch(() => docsCache.delete(strategy));
    docsCache.set(strategy, docsP);
  }
  const [docs, chunks] = await Promise.all([
    docsP,
    new ChunkStore(source, strategy).get(chunkIds).catch(() => {
      throw new HttpError(400, "invalid");
    }),
  ]);
  return chunkIds.map((chunk_id) => {
    const chunk = chunks.get(chunk_id);
    const doc = chunk && docs[chunk.doc_id];
    if (!chunk || !doc) throw new HttpError(400, "invalid");
    return { chunk_id, chunk, doc };
  });
}
