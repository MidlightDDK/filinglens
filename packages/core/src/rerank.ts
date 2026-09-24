import type {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  Tensor,
} from "@huggingface/transformers";
import type { EmbedderOptions } from "./embed.ts";
import { RERANKER_MODEL } from "./models.ts";
import type { Reranker } from "./retrieve.ts";

/** The parts of Transformers.js the reranker needs, injected by each caller. */
export interface RerankerLib {
  AutoModelForSequenceClassification: typeof AutoModelForSequenceClassification;
  AutoTokenizer: typeof AutoTokenizer;
}

/** Loads the pinned cross-encoder: one relevance logit per (query, passage). */
export async function loadReranker(
  { AutoModelForSequenceClassification, AutoTokenizer }: RerankerLib,
  { device, progress_callback }: EmbedderOptions,
): Promise<Reranker> {
  const options = { revision: RERANKER_MODEL.revision, progress_callback };
  const [tokenizer, model] = await Promise.all([
    AutoTokenizer.from_pretrained(RERANKER_MODEL.id, options),
    AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL.id, {
      ...options,
      dtype: RERANKER_MODEL.dtype,
      device,
    }),
  ]);
  return {
    score: async (query, passages) => {
      if (passages.length === 0) return [];
      const inputs = tokenizer(
        passages.map(() => query),
        { text_pair: passages, padding: true, truncation: true },
      );
      const { logits } = (await model(inputs)) as { logits: Tensor };
      return Array.from(logits.data as Float32Array);
    },
  };
}
