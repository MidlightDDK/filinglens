import type {
  AutoModel,
  AutoTokenizer,
  Tensor,
} from "@huggingface/transformers";
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

/** The parts of Transformers.js the embedder needs, injected by each caller. */
export interface TransformersLib {
  AutoModel: typeof AutoModel;
  AutoTokenizer: typeof AutoTokenizer;
}

/**
 * Loads the pinned embedding model. This mirrors Transformers.js's
 * feature-extraction pipeline (CLS pooling, L2 norm) but loads the tokenizer
 * and model directly, because `pipeline()` (4.3.0) fetches config.json from
 * `main` before honoring `revision`.
 */
export async function loadEmbedder(
  { AutoModel, AutoTokenizer }: TransformersLib,
  { device, progress_callback }: EmbedderOptions,
): Promise<Embedder> {
  const options = { revision: EMBEDDING_MODEL.revision, progress_callback };
  const [tokenizer, model] = await Promise.all([
    AutoTokenizer.from_pretrained(EMBEDDING_MODEL.id, options),
    AutoModel.from_pretrained(EMBEDDING_MODEL.id, {
      ...options,
      dtype: EMBEDDING_MODEL.dtype,
      device,
    }),
  ]);
  const embed = async (texts: string[]): Promise<Float32Array[]> => {
    const inputs = tokenizer(texts, { padding: true, truncation: true });
    const { last_hidden_state } = (await model(inputs)) as {
      last_hidden_state: Tensor;
    };
    // CLS pooling, then L2 normalization, exactly as the pipeline does.
    const out = last_hidden_state.slice(null, 0).normalize(2, -1);
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
