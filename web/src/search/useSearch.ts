import { useCallback, useEffect, useRef, useState } from "react";
import { CONFIG_ID } from "../config";
import type {
  Device,
  Passage,
  ReadyInfo,
  WorkerRequest,
  WorkerResponse,
} from "./protocol";

export interface SearchOutcome {
  query: string;
  result: Extract<WorkerResponse, { type: "result" }>["result"];
  passages: Passage[];
  fetch_ms: number;
  /** Main-thread time from submit to results, including worker messaging. */
  wall_ms: number;
}

export type LoadState =
  | { status: "loading"; index: number; model: number }
  | ({ status: "ready" } & ReadyInfo)
  | { status: "error"; message: string };

export type RunSearch = (
  query: string,
  configId?: string,
) => Promise<SearchOutcome>;

interface Pending {
  query: string;
  t0: number;
  resolve: (o: SearchOutcome) => void;
  reject: (e: Error) => void;
}

function forcedDevice(): Device | undefined {
  const d = new URLSearchParams(location.search).get("device");
  return d === "wasm" || d === "webgpu" ? d : undefined;
}

/**
 * One search Web Worker for the whole app (Ask and Pipeline Lab share the
 * model and indexes). `run` resolves with each search's outcome.
 */
export function useSearchEngine() {
  const worker = useRef<Worker | null>(null);
  const pending = useRef(new Map<number, Pending>());
  const nextId = useRef(0);
  const [load, setLoad] = useState<LoadState>({
    status: "loading",
    index: 0,
    model: 0,
  });

  useEffect(() => {
    // Started after first paint: the page never waits for the model or index.
    const w = new Worker(new URL("./search.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = w;
    const waiting = pending.current;
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === "progress") {
        setLoad((s) =>
          s.status === "loading" ? { ...s, [msg.stage]: msg.fraction } : s,
        );
      } else if (msg.type === "ready") {
        const { type: _, ...info } = msg;
        setLoad({ status: "ready", ...info });
      } else if (msg.type === "result") {
        const req = waiting.get(msg.id);
        waiting.delete(msg.id);
        req?.resolve({
          query: req.query,
          result: msg.result,
          passages: msg.passages,
          fetch_ms: msg.fetch_ms,
          wall_ms: Math.round(performance.now() - req.t0),
        });
      } else if (msg.id === undefined) {
        setLoad({ status: "error", message: msg.message });
        for (const req of waiting.values()) req.reject(new Error(msg.message));
        waiting.clear();
      } else {
        waiting.get(msg.id)?.reject(new Error(msg.message));
        waiting.delete(msg.id);
      }
    };
    w.postMessage({
      type: "init",
      device: forcedDevice(),
    } satisfies WorkerRequest);
    return () => w.terminate();
  }, []);

  const run = useCallback<RunSearch>(
    (query, configId = CONFIG_ID) =>
      new Promise((resolve, reject) => {
        const w = worker.current;
        if (!w) return reject(new Error("search is not ready"));
        const id = ++nextId.current;
        pending.current.set(id, {
          query,
          t0: performance.now(),
          resolve,
          reject,
        });
        w.postMessage({
          type: "search",
          id,
          query,
          configId,
        } satisfies WorkerRequest);
      }),
    [],
  );

  return { load, run };
}

/** The Ask page's search: the newest query wins; older results are dropped. */
export function useLatestSearch(run: RunSearch) {
  const latest = useRef(0);
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = useCallback(
    async (query: string) => {
      const q = query.trim();
      if (!q) return;
      const mine = ++latest.current;
      setBusy(true);
      setError(null);
      try {
        const o = await run(q);
        if (mine === latest.current) setOutcome(o);
      } catch (err) {
        if (mine === latest.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (mine === latest.current) setBusy(false);
      }
    },
    [run],
  );

  /** Drops any search in flight (e.g. when an example is shown instead). */
  const cancel = useCallback(() => {
    latest.current++;
    setBusy(false);
  }, []);

  return { outcome, error, busy, search, cancel };
}
