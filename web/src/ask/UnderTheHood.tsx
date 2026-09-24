import type { Candidate, Ranked } from "@filinglens/core";
import type { AnswerState } from "../answer/useAnswer";
import type { LoadState, SearchOutcome } from "../search/useSearch";

const cell = (r: Ranked | null, digits: number) =>
  r ? `#${r.rank} (${r.score.toFixed(digits)})` : "–";

/** How far the reranker moved a candidate from its fused (RRF) rank. */
export function rerankMove(c: Candidate): string {
  if (!c.rerank) return "";
  const d = c.fused.rank - c.rerank.rank;
  return d > 0 ? `↑${d}` : d < 0 ? `↓${-d}` : "=";
}

export function UnderTheHood({
  outcome,
  load,
  answer,
  precomputed = false,
}: {
  outcome: SearchOutcome;
  load: LoadState;
  answer?: AnswerState;
  /** A precomputed example: retrieval ran in Node on the same WASM kernels. */
  precomputed?: boolean;
}) {
  const done = answer?.status === "done" ? answer.done : undefined;
  const { result, fetch_ms, wall_ms } = outcome;
  const { filters, timings } = result;
  const stages: [string, number][] = [
    ["Filters", timings.filter_ms],
    ["BM25", timings.lexical_ms],
    ["Embed query", timings.embed_ms],
    ["Dense (int8)", timings.dense_ms],
    ["RRF", timings.fuse_ms],
    ["Rerank", timings.rerank_ms],
    ["Fetch passages", fetch_ms],
    precomputed
      ? ["Total", Math.round((timings.total_ms + fetch_ms) * 10) / 10]
      : ["Total (incl. messaging)", wall_ms],
  ];
  return (
    <details className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
      <summary className="cursor-pointer font-medium">Under the hood</summary>
      <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt className="text-slate-500">Filters</dt>
        <dd>
          {filters.doc_ids
            ? `${filters.tickers.join(", ") || "all companies"}${
                filters.fiscal_years.length
                  ? ` · FY${filters.fiscal_years.join(", FY")}`
                  : ""
              }${filters.latest ? " · latest filing" : ""} (${filters.doc_ids.length} filings)`
            : "none (all filings)"}
          {filters.notes.map((n) => (
            <span key={n} className="block text-slate-500">
              {n}
            </span>
          ))}
        </dd>
        {load.status === "ready" && (
          <>
            <dt className="text-slate-500">Model</dt>
            <dd className="break-all">
              {load.model}@{load.revision.slice(0, 7)} ({load.dtype}) on{" "}
              {precomputed
                ? "WASM in Node (precomputed by pnpm examples)"
                : load.device === "webgpu"
                  ? "WebGPU"
                  : "WASM"}
            </dd>
            <dt className="text-slate-500">Index</dt>
            <dd>
              {load.strategy} chunks, {load.n.toLocaleString()} passages ·
              config {result.config_id}
            </dd>
          </>
        )}
        {done && (
          <>
            <dt className="text-slate-500">LLM</dt>
            <dd className="break-all" data-testid="llm">
              {done.model} via {done.provider}
              {done.cached ? " (cached answer)" : ""}
            </dd>
            <dt className="text-slate-500">Prompt</dt>
            <dd>{done.promptVersion}</dd>
            <dt className="text-slate-500">Tokens</dt>
            <dd>
              {done.usage
                ? `${done.usage.prompt_tokens.toLocaleString()} in · ${done.usage.completion_tokens.toLocaleString()} out`
                : "not reported"}
            </dd>
            <dt className="text-slate-500">Answer latency</dt>
            <dd>{done.latencyMs.toLocaleString()} ms (server)</dd>
          </>
        )}
      </dl>

      <h3 className="mt-4 font-medium">Stage timings (ms)</h3>
      <table className="mt-1">
        <tbody>
          {stages.map(([name, ms]) => (
            <tr key={name}>
              <td className="pr-4 text-slate-500">{name}</td>
              <td className="text-right tabular-nums">{ms}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="mt-4 font-medium">
        Candidates ({result.candidates.length}, fused with RRF)
      </h3>
      <div className="mt-1 overflow-x-auto">
        <table
          className="w-full text-left tabular-nums"
          data-testid="candidates"
        >
          <thead className="text-slate-500">
            <tr>
              <th className="pr-3 font-normal">#</th>
              <th className="pr-3 font-normal">Chunk</th>
              <th className="pr-3 font-normal">BM25</th>
              <th className="pr-3 font-normal">Dense</th>
              <th className="pr-3 font-normal">RRF</th>
              <th className="font-normal">Rerank</th>
            </tr>
          </thead>
          <tbody>
            {result.candidates.map((c, i) => (
              <tr key={c.chunk_id} data-chunk-id={c.chunk_id}>
                <td className="pr-3">{i + 1}</td>
                <td className="pr-3 whitespace-nowrap">{c.chunk_id}</td>
                <td className="pr-3 whitespace-nowrap">{cell(c.lexical, 2)}</td>
                <td className="pr-3 whitespace-nowrap">{cell(c.dense, 3)}</td>
                <td className="pr-3">{c.fused.score.toFixed(4)}</td>
                <td className="whitespace-nowrap">
                  {cell(c.rerank, 3)} {rerankMove(c)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
