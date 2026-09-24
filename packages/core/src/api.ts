// The Worker's HTTP contract, shared by the Worker and the browser.
import type { SupportVerdict } from "./judge.ts";

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
