// Pinned models. The pipeline tokenizer (pipeline/pipeline/tokenizer.py) must use
// the same id and revision; scripts/src/models.test.ts checks that they match.
export const EMBEDDING_MODEL = {
  id: "Xenova/bge-small-en-v1.5",
  revision: "ea104dacec62c0de699686887e3f920caeb4f3e3",
  // Same dtype in Node and in the browser: q8 = onnx/model_quantized.onnx (~34 MB).
  dtype: "q8",
  dim: 384,
  // Query instruction from https://huggingface.co/BAAI/bge-small-en-v1.5;
  // passages are embedded without a prefix.
  queryPrefix: "Represent this sentence for searching relevant passages: ",
} as const;

// Optional cross-encoder rerank stage (retrieval configs with `rerank`). It is
// kept in the app only if evals show a gain worth its latency.
export const RERANKER_MODEL = {
  id: "Xenova/ms-marco-MiniLM-L-6-v2",
  revision: "a09144355adeed5f58c8ed011d209bf8ee5a1fec",
  // q8 = onnx/model_quantized.onnx (~23 MB).
  dtype: "q8",
} as const;
