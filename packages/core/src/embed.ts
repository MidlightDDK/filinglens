import type { pipeline } from "@huggingface/transformers";
import { EMBEDDING_MODEL } from "./models.ts";

export interface Embedder {
  device: string;
  /** L2-normalized passage embeddings (no prefix). */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** L2-normalized query embedding (with the model's query prefix). */
  embedQuery(query: string): Promise<Float32Array>;
}

export interface EmbedderOptions {
  device: "cpu" | "wasm" | "webgpu" | "auto";
  progress_callback?: (info: unknown) => void;
}

/** Loads the pinned embedding model through an injected Transformers.js `pipeline`. */
export async function loadEmbedder(
  pipelineFn: typeof pipeline,
  { device, progress_callback }: EmbedderOptions,
): Promise<Embedder> {
  const extractor = await pipelineFn("feature-extraction", EMBEDDING_MODEL.id, {
    revision: EMBEDDING_MODEL.revision,
    dtype: EMBEDDING_MODEL.dtype,
    device,
    progress_callback,
  });
  const embed = async (texts: string[]): Promise<Float32Array[]> => {
    const out = await extractor(texts, {
      pooling: EMBEDDING_MODEL.pooling,
      normalize: true,
    });
    const dim = out.dims.at(-1) ?? EMBEDDING_MODEL.dim;
    const data = out.data as Float32Array;
    return texts.map((_, i) => data.slice(i * dim, (i + 1) * dim));
  };
  return {
    device,
    embed,
    embedQuery: async (query) => {
      const [vector] = await embed([EMBEDDING_MODEL.queryPrefix + query]);
      if (!vector) throw new Error("embedding failed");
      return vector;
    },
  };
}
