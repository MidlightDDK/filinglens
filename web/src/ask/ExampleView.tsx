import type { ExampleFile } from "@filinglens/core";
import { type ActiveCite, Answer } from "../answer/Answer";
import type { AnswerState } from "../answer/useAnswer";
import type { JudgeState } from "../answer/useVerify";
import type { LoadState, SearchOutcome } from "../search/useSearch";
import { Passages } from "./Passages";
import { UnderTheHood } from "./UnderTheHood";

const noop = () => {};

/** A precomputed example, shown exactly like a live answer. */
export function ExampleView({
  example,
  active,
  onCite,
  onRunLive,
  running,
  canRun,
}: {
  example: ExampleFile;
  active: ActiveCite | null;
  onCite: (cite: ActiveCite) => void;
  onRunLive: () => void;
  running: boolean;
  canRun: boolean;
}) {
  const { question, retrieval, answer } = example;
  const outcome: SearchOutcome = {
    query: question,
    result: retrieval.result,
    passages: retrieval.passages,
    fetch_ms: retrieval.fetch_ms,
    wall_ms: retrieval.result.timings.total_ms,
  };
  const state: AnswerState = { status: "done", ...answer, question };
  const judge: JudgeState = example.judge
    ? { status: "done", answer: answer.text, result: example.judge }
    : { status: "idle" };
  const load: LoadState = {
    status: "ready",
    device: "wasm",
    ...retrieval.runtime,
    load_ms: 0,
  };
  const date = example.created_at.slice(0, 10);

  return (
    <section
      aria-label="Results"
      data-testid="example"
      className="flex flex-col gap-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-100 px-4 py-3 text-sm text-slate-700">
        <p className="min-w-0 flex-1">
          <span className="font-medium text-slate-900">
            Precomputed example
          </span>{" "}
          (generated {date} with the same pipeline), so it shows instantly even
          when the free AI quotas run out.
        </p>
        <button
          type="button"
          onClick={onRunLive}
          disabled={!canRun || running}
          className="rounded-md bg-slate-900 px-3 py-1.5 font-medium text-white disabled:opacity-50"
        >
          {running ? "Running live…" : "Run live"}
        </button>
      </div>
      <Answer
        state={state}
        sources={retrieval.passages}
        active={active}
        onCite={onCite}
        judge={judge}
        onJudge={example.judge ? noop : undefined}
      />
      <h2 className="font-medium">Sources</h2>
      <Passages passages={retrieval.passages} active={active} />
      <UnderTheHood outcome={outcome} load={load} answer={state} precomputed />
    </section>
  );
}
