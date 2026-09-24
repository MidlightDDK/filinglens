// The retrieval configs the evals compare (evals/configs/*.json). The Ask page
// uses `default`; the Pipeline Lab can run any of them in the browser.
import type { RetrievalConfig } from "@filinglens/core";
import defaultConfig from "../../evals/configs/default.json";
import denseOnly from "../../evals/configs/dense-only.json";
import fixed from "../../evals/configs/fixed.json";
import lexicalOnly from "../../evals/configs/lexical-only.json";
import noFilters from "../../evals/configs/no-filters.json";
import rerank from "../../evals/configs/rerank.json";

export const CONFIGS: Record<string, RetrievalConfig> = Object.fromEntries(
  [defaultConfig, denseOnly, lexicalOnly, noFilters, fixed, rerank].map((c) => [
    c.id,
    c as RetrievalConfig,
  ]),
);

/** What each config changes relative to `default`. */
export const CONFIG_NOTES: Record<string, string> = {
  default:
    "Structure-aware chunks, company and year filters, BM25 and dense retrieval fused with RRF.",
  "dense-only": "Embeddings only: no BM25.",
  "lexical-only": "BM25 only: no embeddings.",
  "no-filters": "No company or fiscal-year filters.",
  fixed:
    "Fixed-size chunks instead of structure-aware ones (loads a second index).",
  rerank:
    "Adds a cross-encoder rerank of the top 30 (downloads a ~23 MB model on first use).",
};
