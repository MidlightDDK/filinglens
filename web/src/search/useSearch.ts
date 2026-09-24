import { useCallback, useEffect, useRef, useState } from "react";
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

function forcedDevice(): Device | undefined {
  const d = new URLSearchParams(location.search).get("device");
  return d === "wasm" || d === "webgpu" ? d : undefined;
}

export function useSearch() {
  const worker = useRef<Worker | null>(null);
  const pending = useRef(new Map<number, { query: string; t0: number }>());
  const nextId = useRef(0);
  const [load, setLoad] = useState<LoadState>({
    status: "loading",
    index: 0,
    model: 0,
  });
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Started after first paint: the page never waits for the model or index.
    const w = new Worker(new URL("./search.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = w;
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
        const req = pending.current.get(msg.id);
        pending.current.delete(msg.id);
        if (!req || msg.id !== nextId.current) return; // a newer search won
        setOutcome({
          query: req.query,
          result: msg.result,
          passages: msg.passages,
          fetch_ms: msg.fetch_ms,
          wall_ms: Math.round(performance.now() - req.t0),
        });
        setBusy(false);
      } else if (msg.id === undefined) {
        setLoad({ status: "error", message: msg.message });
      } else {
        pending.current.delete(msg.id);
        setError(msg.message);
        setBusy(false);
      }
    };
    w.postMessage({
      type: "init",
      device: forcedDevice(),
    } satisfies WorkerRequest);
    return () => w.terminate();
  }, []);

  const search = useCallback((query: string) => {
    const q = query.trim();
    if (!q || !worker.current) return;
    const id = ++nextId.current;
    pending.current.set(id, { query: q, t0: performance.now() });
    setBusy(true);
    setError(null);
    worker.current.postMessage({
      type: "search",
      id,
      query: q,
    } satisfies WorkerRequest);
  }, []);

  return { load, outcome, error, busy, search };
}
