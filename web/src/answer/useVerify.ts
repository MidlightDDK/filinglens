import type {
  ErrorReason,
  VerifyRequest,
  VerifyResponse,
} from "@filinglens/core";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { API_BASE } from "../config";
import { ApiError, ensureSession, reasonOf } from "./useAnswer";

/** The AI judge's pass over one answer (`answer` is the text it judged). */
export type JudgeState =
  | { status: "idle" }
  | { status: "pending"; answer: string }
  | { status: "done"; answer: string; result: VerifyResponse }
  | { status: "error"; answer: string; reason: ErrorReason | "network" };

/** Asks `/api/verify` whether each cited sentence is backed by its sources. */
export function useVerify(turnstileRef: RefObject<HTMLElement | null>) {
  const [state, setState] = useState<JudgeState>({ status: "idle" });
  const current = useRef<AbortController | null>(null);

  useEffect(() => () => current.current?.abort(), []);

  const verify = useCallback(
    async (request: VerifyRequest) => {
      current.current?.abort();
      const ctrl = new AbortController();
      current.current = ctrl;
      const update = (s: JudgeState) => {
        if (!ctrl.signal.aborted) setState(s);
      };
      const answer = request.answer;
      update({ status: "pending", answer });
      const container = turnstileRef.current;
      if (!container) return;
      const post = () =>
        fetch(`${API_BASE}/verify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: ctrl.signal,
        });
      try {
        await ensureSession(container, () => {});
        let res = await post();
        if (res.status === 401) {
          await ensureSession(container, () => {}, true);
          res = await post();
        }
        if (!res.ok) throw new ApiError(await reasonOf(res));
        const result = (await res.json()) as VerifyResponse;
        update({ status: "done", answer, result });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        update({
          status: "error",
          answer,
          reason: err instanceof ApiError ? err.reason : "network",
        });
      }
    },
    [turnstileRef],
  );

  return { state, verify };
}
