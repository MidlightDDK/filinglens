import { type FormEvent, useRef, useState } from "react";
import { type ActiveCite, Answer } from "../answer/Answer";
import { type AnswerState, useAnswer } from "../answer/useAnswer";
import { EXAMPLES } from "../ask/examples";
import { PassageText } from "../ask/Passages";
import { CONFIG_NOTES, CONFIGS } from "../configs";
import { ConfigTable } from "../evals/ConfigTable";
import { type ConfigSummary, pct, useReport } from "../evals/report";
import type { LoadState, RunSearch, SearchOutcome } from "../search/useSearch";
import { sharedWith } from "./overlap";

type Run =
  | { status: "idle" }
  | { status: "running" }
  | { status: "error"; message: string }
  | {
      status: "done";
      question: string;
      configIds: [string, string];
      sides: [SearchOutcome, SearchOutcome];
    };

const LABELS = ["A", "B"] as const;
const ids = (o: SearchOutcome) => o.passages.map((p) => p.candidate.chunk_id);

function Side({
  label,
  configId,
  outcome,
  other,
  summary,
  answer,
  active,
  onCite,
}: {
  label: string;
  configId: string;
  outcome: SearchOutcome;
  other: SearchOutcome;
  summary?: ConfigSummary;
  answer: AnswerState | null;
  active: ActiveCite | null;
  onCite: (c: ActiveCite) => void;
}) {
  const { filters, timings } = outcome.result;
  return (
    <section
      aria-label={`Config ${label}: ${configId}`}
      data-testid={`lab-side-${label}`}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
    >
      <header>
        <h3 className="font-semibold">
          <span className="mr-1.5 rounded bg-slate-900 px-1.5 text-sm text-white">
            {label}
          </span>
          {configId}
        </h3>
        <p className="mt-1 text-xs text-slate-500">{CONFIG_NOTES[configId]}</p>
        <p className="mt-1 text-xs text-slate-600">
          Dev recall@10 {pct(summary?.overall.recall_at_10)} · this query{" "}
          {timings.total_ms} ms
          {timings.rerank_ms ? ` (rerank ${timings.rerank_ms} ms)` : ""} ·
          filters:{" "}
          {filters.doc_ids
            ? `${filters.tickers.join(", ") || "all companies"}${
                filters.fiscal_years.length
                  ? ` FY${filters.fiscal_years.join(", FY")}`
                  : ""
              }`
            : "none"}
        </p>
      </header>
      <ol className="flex flex-col gap-2 text-sm">
        {outcome.passages.map((p, i) => {
          const shared = sharedWith(p, other.passages);
          const isActive = active?.n === i + 1;
          const c = p.candidate;
          return (
            <li
              key={c.chunk_id}
              data-chunk-id={c.chunk_id}
              data-shared={shared}
              className={`rounded border p-2 ${
                isActive
                  ? "border-blue-600 ring-2 ring-blue-200"
                  : "border-slate-200"
              }`}
            >
              <details open={isActive || undefined}>
                <summary className="cursor-pointer">
                  <span className="text-slate-400">[{i + 1}]</span>{" "}
                  {p.doc.company} · FY{p.doc.fy} · Item {p.chunk.item}{" "}
                  <span
                    className={`ml-1 rounded px-1 text-xs ${
                      shared
                        ? "bg-slate-100 text-slate-600"
                        : "bg-amber-100 text-amber-900"
                    }`}
                  >
                    {shared ? "in both" : `only in ${label}`}
                  </span>
                  <span className="block truncate text-xs text-slate-500">
                    {p.chunk.heading_path.at(-1) ?? ""} ·{" "}
                    {c.rerank
                      ? `rerank ${c.rerank.score.toFixed(2)} (RRF #${c.fused.rank})`
                      : `RRF ${c.fused.score.toFixed(4)}`}
                  </span>
                </summary>
                <div className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-800">
                  <PassageText
                    text={p.chunk.text}
                    sentence={isActive ? active?.sentence : undefined}
                  />
                </div>
              </details>
            </li>
          );
        })}
      </ol>
      {answer && (
        <Answer
          state={answer}
          sources={outcome.passages}
          active={active}
          onCite={onCite}
        />
      )}
    </section>
  );
}

export function LabPage({ load, run }: { load: LoadState; run: RunSearch }) {
  const report = useReport();
  const [configIds, setConfigIds] = useState<[string, string]>([
    "default",
    "dense-only",
  ]);
  const [question, setQuestion] = useState<string>(EXAMPLES[2].question);
  const [state, setState] = useState<Run>({ status: "idle" });
  const turnstileRef = useRef<HTMLDivElement>(null);
  const answerA = useAnswer(turnstileRef);
  const answerB = useAnswer(turnstileRef);
  const [active, setActive] = useState<(ActiveCite | null)[]>([null, null]);
  const retrieval = report.status === "ready" ? report.data.retrieval : null;

  const compare = async (e: FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q) return;
    const chosen = configIds;
    setState({ status: "running" });
    setActive([null, null]);
    try {
      // One after the other, so each side's stage timings are its own.
      const a = await run(q, chosen[0]);
      const b = await run(q, chosen[1]);
      setState({
        status: "done",
        question: q,
        configIds: chosen,
        sides: [a, b],
      });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const answers = [answerA, answerB];
  const answerFor = (i: number): AnswerState | null => {
    if (state.status !== "done") return null;
    const s = answers[i]?.state;
    const side = state.sides[i] as SearchOutcome;
    return s &&
      s.status !== "idle" &&
      s.question === state.question &&
      s.chunkIds.join() === ids(side).join()
      ? s
      : null;
  };
  const answerBoth = () => {
    if (state.status !== "done") return;
    state.sides.forEach((side, i) => {
      answers[i]?.ask(state.question, ids(side), state.configIds[i]);
    });
  };
  const answering = [answerFor(0), answerFor(1)].some(
    (s) => s?.status === "pending" || s?.status === "streaming",
  );

  let overlap = 0;
  if (state.status === "done") {
    const [a, b] = state.sides;
    overlap = a.passages.filter((p) => sharedWith(p, b.passages)).length;
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Pipeline Lab</h1>
        <p className="text-slate-700">
          The same question through two retrieval configs, live in your browser.
          The table shows how each config scored on the dev split of the eval
          set (every number comes from{" "}
          <code className="text-sm">pnpm eval:retrieval</code>).
        </p>
      </header>

      <section
        aria-labelledby="configs-heading"
        className="flex flex-col gap-2"
      >
        <h2 id="configs-heading" className="font-medium">
          Measured quality
          {report.status === "ready" &&
            ` (dev split, ${report.data.retrieval.default?.overall.n ?? "?"} scored items)`}
        </h2>
        {retrieval ? (
          <ConfigTable
            configs={retrieval}
            marks={{ [configIds[0]]: "A", [configIds[1]]: "B" }}
          />
        ) : (
          <p className="text-sm text-slate-500">
            {report.status === "error"
              ? "The eval report couldn't be loaded."
              : "Loading the eval report…"}
          </p>
        )}
        <p className="text-xs text-slate-500">
          Recall@k: share of the gold evidence found in the top k passages. MRR
          and nDCG reward finding it near the top. Latency is per query in Node
          on the browser's WASM kernels.
        </p>
      </section>

      <form
        onSubmit={compare}
        className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {LABELS.map((label, i) => (
            <label key={label} className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Config {label}</span>
              <select
                aria-label={`Config ${label}`}
                value={configIds[i]}
                onChange={(e) => {
                  const next: [string, string] = [...configIds];
                  next[i] = e.target.value;
                  setConfigIds(next);
                }}
                className="rounded-md border border-slate-300 bg-white px-2 py-1.5"
              >
                {Object.keys(CONFIGS).map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Question</span>
          <select
            value=""
            onChange={(e) => e.target.value && setQuestion(e.target.value)}
            aria-label="Pick an example question"
            className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-slate-600"
          >
            <option value="">Pick an example question…</option>
            {EXAMPLES.map((ex) => (
              <option key={ex.id} value={ex.question}>
                {ex.kind}: {ex.title}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={500}
            aria-label="Question"
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-base"
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={
              !question.trim() ||
              state.status === "running" ||
              load.status === "error"
            }
            className="rounded-md bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50"
          >
            {state.status === "running" ? "Comparing…" : "Compare retrieval"}
          </button>
          <span className="text-sm text-slate-500" role="status">
            {load.status === "loading"
              ? `Loading the model and index in your browser… ${Math.round(((load.index + load.model) / 2) * 100)}%`
              : state.status === "running" &&
                  configIds.some((id) => CONFIGS[id]?.rerank || id === "fixed")
                ? "First use of this config downloads its index or model."
                : ""}
          </span>
        </div>
        {load.status === "error" && (
          <p role="alert" className="text-sm text-red-700">
            Search is unavailable right now: {load.message}
          </p>
        )}
        {state.status === "error" && (
          <p role="alert" className="text-sm text-red-700">
            Search failed: {state.message}
          </p>
        )}
      </form>

      {/* Turnstile renders here only if a visitor must interact. */}
      <div ref={turnstileRef} />

      {state.status === "done" && (
        <section aria-label="Comparison" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-600" data-testid="lab-overlap">
              {overlap} of {state.sides[0].passages.length} passages in A also
              appear in B's top {state.sides[1].passages.length}.
            </p>
            <button
              type="button"
              onClick={answerBoth}
              disabled={answering}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-60"
            >
              {answering ? "Answering…" : "Answer both with the LLM"}
            </button>
          </div>
          <p className="text-xs text-slate-500">
            Answers use the free LLM quota; the server caches each question and
            passage set, so repeats are instant.
          </p>
          <div className="grid gap-4 lg:grid-cols-2">
            {LABELS.map((label, i) => {
              const id = state.configIds[i] as string;
              return (
                <Side
                  key={label}
                  label={label}
                  configId={id}
                  outcome={state.sides[i] as SearchOutcome}
                  other={state.sides[1 - i] as SearchOutcome}
                  summary={retrieval?.[id]}
                  answer={answerFor(i)}
                  active={active[i] ?? null}
                  onCite={(c) =>
                    setActive((prev) => prev.map((a, j) => (j === i ? c : a)))
                  }
                />
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
