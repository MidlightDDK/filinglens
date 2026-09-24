import { type FormEvent, useEffect, useRef, useState } from "react";
import { type ActiveCite, Answer } from "./answer/Answer";
import { useAnswer } from "./answer/useAnswer";
import { useVerify } from "./answer/useVerify";
import { Passages } from "./ask/Passages";
import { UnderTheHood } from "./ask/UnderTheHood";
import { CONFIG_ID } from "./config";
import { type LoadState, useSearch } from "./search/useSearch";

function LoadStatus({ load }: { load: LoadState }) {
  if (load.status === "error") {
    return (
      <p role="alert" className="text-sm text-red-700">
        Search is unavailable right now: {load.message}
      </p>
    );
  }
  if (load.status === "ready") {
    return (
      <p className="text-sm text-slate-500" data-testid="load-status">
        Ready: {load.n.toLocaleString()} passages, model on{" "}
        {load.device === "webgpu" ? "WebGPU" : "WASM"} (loaded in{" "}
        {(load.load_ms / 1000).toFixed(1)} s)
      </p>
    );
  }
  const pct = Math.round(((load.index + load.model) / 2) * 100);
  return (
    <div className="text-sm text-slate-500">
      <p>
        Loading the search index and embedding model in your browser… {pct}%
      </p>
      <progress className="mt-1 h-1.5 w-full" max={100} value={pct}>
        {pct}%
      </progress>
    </div>
  );
}

export function App() {
  const { load, outcome, error, busy, search } = useSearch();
  const turnstileRef = useRef<HTMLDivElement>(null);
  const { state: answer, ask, prepare, checkNeeded } = useAnswer(turnstileRef);
  const { state: judge, verify } = useVerify(turnstileRef);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<ActiveCite | null>(null);

  // Each retrieval result is answered from its top passages, in order.
  useEffect(() => {
    if (!outcome) return;
    setActive(null);
    if (outcome.passages.length) {
      ask(
        outcome.query,
        outcome.passages.map((p) => p.candidate.chunk_id),
      );
    }
  }, [outcome, ask]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    search(query);
  };
  const answering =
    answer.status === "pending" || answer.status === "streaming";

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 px-4 py-10 text-slate-900 sm:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-4xl font-semibold tracking-tight">FilingLens</h1>
        <p className="text-lg text-slate-700">
          Ask about the 10-K annual reports of 12 public companies. Retrieval
          runs in your browser, and every sentence of the answer cites the
          passage it came from.
        </p>
      </header>

      <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="q" className="sr-only">
          Ask a question about the filings
        </label>
        <input
          id="q"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={prepare}
          maxLength={500}
          placeholder="e.g. What was NVIDIA's data center revenue in FY2026?"
          className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-base shadow-sm focus:border-slate-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!query.trim() || load.status === "error"}
          className="rounded-md bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {busy || answering ? "Asking…" : "Ask"}
        </button>
      </form>

      {/* Turnstile renders here only if a visitor must interact. */}
      <div ref={turnstileRef} />
      <LoadStatus load={load} />
      {error && (
        <p role="alert" className="text-sm text-red-700">
          Search failed: {error}
        </p>
      )}

      {outcome && (
        <section aria-label="Results" className="flex flex-col gap-4">
          <p className="text-sm text-slate-500" data-testid="result-summary">
            Top {outcome.passages.length} passages for “{outcome.query}” in{" "}
            <span data-testid="wall-ms">{outcome.wall_ms}</span> ms
          </p>
          <Answer
            state={answer}
            sources={outcome.passages}
            active={active}
            onCite={setActive}
            checkNeeded={checkNeeded}
            judge={judge}
            onJudge={() =>
              answer.status === "done" &&
              verify({
                question: answer.question,
                answer: answer.text,
                chunkIds: answer.chunkIds,
                configId: CONFIG_ID,
              })
            }
          />
          <h2 className="font-medium">Sources</h2>
          <Passages passages={outcome.passages} active={active} />
          <UnderTheHood outcome={outcome} load={load} answer={answer} />
        </section>
      )}
    </main>
  );
}
