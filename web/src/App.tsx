import { type FormEvent, useState } from "react";
import { Passages } from "./ask/Passages";
import { UnderTheHood } from "./ask/UnderTheHood";
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
  const [query, setQuery] = useState("");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    search(query);
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 px-4 py-10 text-slate-900 sm:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-4xl font-semibold tracking-tight">FilingLens</h1>
        <p className="text-lg text-slate-700">
          Search the 10-K annual reports of 12 public companies. Retrieval runs
          entirely in your browser; cited answers come next.
        </p>
      </header>

      <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="q" className="sr-only">
          Search the filings
        </label>
        <input
          id="q"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. NVIDIA data center revenue FY2026"
          className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-base shadow-sm focus:border-slate-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!query.trim() || load.status === "error"}
          className="rounded-md bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {busy ? "Searching…" : "Search"}
        </button>
      </form>

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
          <Passages passages={outcome.passages} />
          <UnderTheHood outcome={outcome} load={load} />
        </section>
      )}
    </main>
  );
}
