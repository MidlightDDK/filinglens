import {
  type AnswerDone,
  type AnswerRequest,
  type ErrorReason,
  parseSSE,
} from "@filinglens/core";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { API_BASE, CONFIG_ID } from "../config";
import { turnstileToken } from "./turnstile";

export type AnswerState =
  | { status: "idle" }
  | {
      status: "pending" | "streaming" | "done" | "error";
      question: string;
      chunkIds: string[];
      text: string;
      done?: AnswerDone;
      reason?: ErrorReason | "network";
    };

/** When the session cookie expires (ms); the cookie itself is HttpOnly. */
let sessionUntil = 0;
let sessionP: Promise<void> | null = null;

type OnInteractive = (active: boolean) => void;

async function newSession(
  container: HTMLElement,
  onInteractive: OnInteractive,
): Promise<void> {
  const token = await turnstileToken(container, onInteractive);
  const res = await fetch(`${API_BASE}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turnstileToken: token }),
  });
  if (!res.ok) throw new ApiError(await reasonOf(res));
  sessionUntil = ((await res.json()) as { expiresAt: number }).expiresAt;
}

/** Gets a session unless one is valid for another minute; shares in-flight work. */
function ensureSession(
  container: HTMLElement,
  onInteractive: OnInteractive,
  force = false,
): Promise<void> {
  if (!force && sessionUntil - Date.now() > 60_000) return Promise.resolve();
  sessionP ??= newSession(container, onInteractive).finally(() => {
    sessionP = null;
  });
  return sessionP;
}

class ApiError extends Error {
  readonly reason: ErrorReason | "network";
  constructor(reason: ErrorReason | "network") {
    super(reason);
    this.reason = reason;
  }
}

async function reasonOf(res: Response): Promise<ErrorReason | "network"> {
  try {
    return ((await res.json()) as { reason: ErrorReason }).reason;
  } catch {
    return "network";
  }
}

/**
 * Streams a cited answer from `/api/answer`. `turnstileRef` is where the
 * (usually invisible) Turnstile widget renders when a session is needed.
 */
export function useAnswer(turnstileRef: RefObject<HTMLElement | null>) {
  const [state, setState] = useState<AnswerState>({ status: "idle" });
  /** Turnstile is showing a challenge the visitor has to complete. */
  const [checkNeeded, setCheckNeeded] = useState(false);
  const current = useRef<AbortController | null>(null);

  useEffect(() => () => current.current?.abort(), []);

  /** Warm up a session early (e.g. when the question box gets focus). */
  const prepare = useCallback(() => {
    if (turnstileRef.current) {
      ensureSession(turnstileRef.current, setCheckNeeded).catch(() => {});
    }
  }, [turnstileRef]);

  const ask = useCallback(
    async (question: string, chunkIds: string[]) => {
      current.current?.abort();
      const ctrl = new AbortController();
      current.current = ctrl;
      const base = { question, chunkIds, text: "" };
      const update = (s: AnswerState) => {
        if (!ctrl.signal.aborted) setState(s);
      };
      update({ status: "pending", ...base });

      const container = turnstileRef.current;
      if (!container) return;
      const request: AnswerRequest = {
        question,
        chunkIds,
        configId: CONFIG_ID,
      };
      const post = () =>
        fetch(`${API_BASE}/answer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: ctrl.signal,
        });

      let text = "";
      let ended = false;
      try {
        await ensureSession(container, setCheckNeeded);
        let res = await post();
        if (res.status === 401) {
          await ensureSession(container, setCheckNeeded, true);
          res = await post();
        }
        if (!res.ok || !res.body) throw new ApiError(await reasonOf(res));
        for await (const ev of parseSSE(res.body)) {
          const data = JSON.parse(ev.data);
          if (ev.event === "token") {
            text += (data as { text: string }).text;
            update({ status: "streaming", ...base, text });
          } else if (ev.event === "done") {
            ended = true;
            update({ status: "done", ...base, text, done: data as AnswerDone });
          } else if (ev.event === "error") {
            ended = true;
            const { reason } = data as { reason: ErrorReason };
            update({ status: "error", ...base, text, reason });
          }
        }
        if (!ended) throw new ApiError("network"); // connection dropped
      } catch (err) {
        if (ctrl.signal.aborted) return;
        const reason =
          err instanceof ApiError
            ? err.reason
            : err instanceof Error && err.message.startsWith("Turnstile")
              ? "turnstile"
              : "network";
        update({ status: "error", ...base, text, reason });
      }
    },
    [turnstileRef],
  );

  return { state, ask, prepare, checkNeeded };
}
