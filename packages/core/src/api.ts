// The Worker's HTTP contract, shared by the Worker and the browser.

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
