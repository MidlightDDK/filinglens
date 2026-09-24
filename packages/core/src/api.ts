// The Worker's HTTP contract, shared by the Worker and the browser.
import type { DocInfo } from "./filters.ts";
import type { SupportVerdict } from "./judge.ts";
import type { Candidate, RetrievalResult } from "./retrieve.ts";
import type { ChunkRecord } from "./store.ts";

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

/** POST /api/answer body. `[n]` in the answer refers to `chunkIds[n - 1]`. */
export interface AnswerRequest {
  question: string;
  chunkIds: string[];
  configId: string;
}

/** Payload of the final `done` event of /api/answer. */
export interface AnswerDone {
  provider: string;
  model: string;
  promptVersion: string;
  usage: Usage | null;
  latencyMs: number;
  cached: boolean;
}

/** POST /api/verify body: the answer to check against the same sources. */
export interface VerifyRequest {
  question: string;
  answer: string;
  chunkIds: string[];
  configId: string;
}

/** POST /api/verify response. Claims the judge skipped have no verdict. */
export interface VerifyResponse {
  verdicts: SupportVerdict[];
  provider: string;
  model: string;
  judgeVersion: string;
  cached: boolean;
}

/** `{reason}` of an error response or of an `error` event. */
export type ErrorReason =
  | "origin"
  | "too_large"
  | "invalid"
  | "session"
  | "turnstile"
  | "rate_limit"
  | "quota"
  | "provider"
  | "unavailable"
  | "not_found"
  | "method_not_allowed"
  | "internal";

/** A retrieved passage with its text and filing, as the Ask page shows it. */
export interface Passage {
  candidate: Candidate;
  chunk: ChunkRecord;
  doc: DocInfo;
}

/**
 * A precomputed example (`pnpm examples` → `web/public/examples/{id}.json`):
 * everything the Ask page shows for a live answer, so example chips work
 * without the index, the model, or any LLM provider.
 */
export interface ExampleFile {
  id: string;
  category: string;
  question: string;
  created_at: string;
  commit: string | null;
  retrieval: {
    result: RetrievalResult;
    passages: Passage[];
    fetch_ms: number;
    /** Where retrieval ran: Node, on the browser's WASM kernels. */
    runtime: {
      model: string;
      revision: string;
      dtype: string;
      strategy: string;
      n: number;
    };
  };
  answer: { text: string; chunkIds: string[]; done: AnswerDone };
  /** The support judge's verdicts, as `/api/verify` returns them. */
  judge: VerifyResponse | null;
}
