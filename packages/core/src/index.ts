export type {
  AnswerDone,
  AnswerRequest,
  ErrorReason,
  Usage,
  VerifyRequest,
  VerifyResponse,
} from "./api.ts";
export {
  type Citation,
  MARKER,
  parseCitations,
  type Segment,
  type Span,
  segmentMarkers,
  splitSentences,
} from "./citations.ts";
export { quantize, searchDense } from "./dense.ts";
export { type Embedder, type EmbedderOptions, loadEmbedder } from "./embed.ts";
export {
  type DocInfo,
  type Docs,
  detectFilters,
  type QueryFilters,
} from "./filters.ts";
export {
  buildSupportPrompt,
  type Claim,
  claimsOf,
  firstJsonObject,
  JUDGE_VERSION,
  parseSupportVerdicts,
  type SupportVerdict,
} from "./judge.ts";
export {
  buildLexicalIndex,
  type Hit,
  type LexicalIndexFile,
  loadLexicalIndex,
  searchLexical,
  tokenize,
} from "./lexical.ts";
export { EMBEDDING_MODEL, RERANKER_MODEL } from "./models.ts";
export {
  buildPrompt,
  type ChatMessage,
  INSUFFICIENT,
  PROMPT_VERSION,
  type PromptSource,
  parseInsufficient,
  sourceLabel,
} from "./prompt.ts";
export { loadReranker, type RerankerLib } from "./rerank.ts";
export {
  type Candidate,
  type Ranked,
  type Reranker,
  type RetrievalConfig,
  type RetrievalResult,
  type RetrieveDeps,
  retrieve,
  rrf,
  type Timings,
} from "./retrieve.ts";
export { formatSSE, parseSSE, type SSEEvent } from "./sse.ts";
export {
  type ChunkRecord,
  ChunkStore,
  type IndexMeta,
  type IndexRows,
  type IndexSource,
  type LoadedIndex,
  loadIndex,
  SHARDS,
  shardOf,
} from "./store.ts";
export {
  answerSentences,
  type ChunkText,
  extractNumbers,
  highlightSpan,
  type NumberMention,
  numbersMatch,
  type SentenceCheck,
  type SentenceStatus,
  verifyAnswer,
  verifySentence,
  verifySentences,
  withJudge,
} from "./verify.ts";
