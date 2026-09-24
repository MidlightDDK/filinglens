import type { ReactNode } from "react";
import { ConfigTable } from "./ConfigTable";
import {
  type Agreement,
  type AnswerReport,
  commitUrl,
  type FailureExample,
  pct,
  type Report,
  type TrendPoint,
  useJson,
  useReport,
} from "./report";

const CATEGORY_LABELS: Record<string, string> = {
  lookup: "Lookup",
  table_number: "Table number",
  comparison: "Comparison",
  trend: "Trend",
  multi_hop: "Multi-hop",
  false_premise: "False premise",
  unanswerable: "Unanswerable",
};
const SOURCE_LABELS: Record<string, string> = {
  xbrl: "XBRL (generated from the filings' tagged financial data)",
  synthetic_reviewed: "Synthetic (LLM-proposed, reviewed)",
  handwritten: "Handwritten (hard cases)",
};
const label = (map: Record<string, string>, k: string) => map[k] ?? k;
const cell = "py-1.5 pr-3";
const num = `${cell} text-right tabular-nums`;

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-xl font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Commit({ commit }: { commit: string | null }) {
  if (!commit) return <>unknown commit</>;
  return (
    <a
      href={commitUrl(commit)}
      className="font-mono text-blue-700 underline"
      target="_blank"
      rel="noreferrer"
    >
      {commit.slice(0, 7)}
    </a>
  );
}

function Dataset({ report }: { report: Report }) {
  const comp = report.dataset.composition;
  if (!comp) {
    return (
      <p className="text-sm text-slate-600">
        {report.dataset.items} {report.split} items.
      </p>
    );
  }
  const total = comp.total.dev + comp.total.test;
  const table = (rows: [string, { dev: number; test: number }][]) => (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[24rem] text-left text-sm">
        <thead className="text-slate-500">
          <tr className="border-b border-slate-200">
            <th className={`${cell} font-normal`} />
            <th className={`${num} font-normal`}>Dev</th>
            <th className={`${num} font-normal`}>Test</th>
            <th className={`${num} font-normal`}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, c]) => (
            <tr key={name} className="border-b border-slate-100">
              <td className={cell}>{name}</td>
              <td className={num}>{c.dev}</td>
              <td className={num}>{c.test}</td>
              <td className={num}>{c.dev + c.test}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <>
      <p className="text-sm text-slate-700" data-testid="dataset-summary">
        {total} questions with gold answers and gold evidence spans (character
        offsets into the filing text): {comp.total.dev} dev, {comp.total.test}{" "}
        test. The test split is held out for release numbers. At the project
        owner's request, Claude (the AI assistant that built this site) reviewed
        the synthetic items and wrote the handwritten ones, checking each
        against the filing text.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {table(
          Object.entries(comp.categories).map(([k, c]) => [
            label(CATEGORY_LABELS, k),
            c,
          ]),
        )}
        {table(
          Object.entries(comp.sources).map(([k, c]) => [
            label(SOURCE_LABELS, k),
            c,
          ]),
        )}
      </div>
    </>
  );
}

function AnswerMetrics({ answers }: { answers: AnswerReport }) {
  const s = answers.summary;
  const rows: [string, string, number | string, string][] = [
    [
      "Accuracy",
      pct(s.accuracy.value),
      s.accuracy.n,
      "Numeric match, judge, or correct abstention, per item",
    ],
    [
      "Numeric exact match",
      pct(s.numeric_em.value),
      s.numeric_em.n,
      "The gold number, within tolerance",
    ],
    [
      "Judge correctness",
      pct(s.judge_correct.value),
      s.judge_correct.n,
      "Non-numeric answers, graded by the LLM judge",
    ],
    [
      "False-premise correction",
      pct(s.false_premise_correction.value),
      s.false_premise_correction.n,
      "Says the question's premise is wrong",
    ],
    [
      "Abstention precision / recall",
      `${pct(s.abstention.precision)} / ${pct(s.abstention.recall)}`,
      s.abstention.unanswerable,
      "Declines exactly the questions the filings can't answer",
    ],
    [
      "Citation coverage",
      pct(s.citation_coverage),
      s.sentences,
      "Sentences with at least one valid citation",
    ],
    [
      "Citation precision",
      pct(s.citation_precision),
      "",
      "Citations that overlap gold evidence or pass the support judge",
    ],
    [
      "Verified sentences",
      pct(s.verified_rate),
      s.sentences,
      "Cited, and every number found in the cited passage",
    ],
    [
      "Unsupported (judge)",
      pct(s.unsupported_rate),
      "",
      "Cited sentences the support judge rejected",
    ],
  ];
  return (
    <>
      <p className="text-sm text-slate-700">
        {answers.dataset.items} dev items (
        {answers.dataset.sampled === "all"
          ? "the whole split"
          : "stratified by category"}
        ), answered by {answers.generator.model} via{" "}
        {answers.generator.provider} with prompt {answers.prompt_version} and
        the <span className="font-mono">{answers.config}</span> retrieval
        config; judged by {answers.judge?.model ?? "no judge"}. Run{" "}
        <Commit commit={answers.commit} /> on {answers.created_at.slice(0, 10)}.
      </p>
      <div className="overflow-x-auto">
        <table
          className="w-full min-w-[36rem] text-left text-sm"
          data-testid="answer-metrics"
        >
          <thead className="text-slate-500">
            <tr className="border-b border-slate-200">
              <th className={`${cell} font-normal`}>Metric</th>
              <th className={`${num} font-normal`}>Value</th>
              <th className={`${num} font-normal`}>n</th>
              <th className={`${cell} font-normal`}>What it measures</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, value, n, what]) => (
              <tr key={name} className="border-b border-slate-100 align-top">
                <td className={cell}>{name}</td>
                <td className={`${num} font-medium`}>{value}</td>
                <td className={`${num} text-slate-500`}>{n}</td>
                <td className={`${cell} text-slate-600`}>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-slate-600">
        Accuracy by category:{" "}
        {Object.entries(s.per_category)
          .map(
            ([k, v]) =>
              `${label(CATEGORY_LABELS, k)} ${pct(v.accuracy, 0)} (n=${v.n})`,
          )
          .join(" · ")}
        . Latency p50/p95: retrieval {s.latency_ms.retrieval.p50}/
        {s.latency_ms.retrieval.p95} ms, generation{" "}
        {(s.latency_ms.generation.p50 / 1000).toFixed(1)}/
        {(s.latency_ms.generation.p95 / 1000).toFixed(1)} s. Tokens:{" "}
        {s.tokens.in.toLocaleString()} in, {s.tokens.out.toLocaleString()} out.
      </p>
    </>
  );
}

function JudgeAgreement({ judge }: { judge: NonNullable<Report["judge"]> }) {
  const row = (name: string, a: Agreement, version: string) => (
    <tr className="border-b border-slate-100">
      <td className={cell}>
        {name} <span className="text-xs text-slate-500">({version})</span>
      </td>
      <td className={`${num} font-medium`}>{pct(a.agreement)}</td>
      <td className={num}>{a.kappa.toFixed(2)}</td>
      <td className={`${num} text-slate-500`}>{a.n}</td>
    </tr>
  );
  const misses = [
    ...judge.correctness.disagreements,
    ...judge.support.disagreements,
  ];
  return (
    <>
      <p className="text-sm text-slate-700">
        The judge ({judge.judge_model}) graded labeled answers whose right
        verdict is known. Every judged metric above depends on this agreement.
      </p>
      <div className="overflow-x-auto">
        <table
          className="w-full min-w-[28rem] text-left text-sm"
          data-testid="judge-agreement"
        >
          <thead className="text-slate-500">
            <tr className="border-b border-slate-200">
              <th className={`${cell} font-normal`}>Judge</th>
              <th className={`${num} font-normal`}>Agreement</th>
              <th className={`${num} font-normal`}>Cohen's kappa</th>
              <th className={`${num} font-normal`}>Labels</th>
            </tr>
          </thead>
          <tbody>
            {row("Correctness", judge.correctness, judge.correctness_version)}
            {row("Support", judge.support, judge.support_version)}
          </tbody>
        </table>
      </div>
      {misses.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-slate-700">
            {misses.length} disagreement{misses.length === 1 ? "" : "s"} with
            the labels
          </summary>
          <ul className="mt-2 flex flex-col gap-1 text-slate-600">
            {misses.map((d) => (
              <li key={d.id}>
                <span className="font-mono text-xs">{d.id}</span>: label{" "}
                <em>{d.human}</em>, judge <em>{d.judge}</em> ("{d.reason}")
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function Trend({ points }: { points: TrendPoint[] }) {
  return (
    <div className="overflow-x-auto">
      <table
        className="w-full min-w-[40rem] text-left text-sm"
        data-testid="trend"
      >
        <thead className="text-slate-500">
          <tr className="border-b border-slate-200">
            <th className={`${cell} font-normal`}>Release</th>
            <th className={`${num} font-normal`}>Dev items</th>
            <th className={`${num} font-normal`}>Recall@10</th>
            <th className={`${num} font-normal`}>MRR@10</th>
            <th className={`${num} font-normal`}>Answer accuracy</th>
            <th className={`${num} font-normal`}>Verified</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.label} className="border-b border-slate-100">
              <td className={cell}>
                {p.label} · <Commit commit={p.commit} />
              </td>
              <td className={num}>{p.items}</td>
              <td className={num}>{pct(p.retrieval?.recall_at_10)}</td>
              <td className={num}>{pct(p.retrieval?.mrr_at_10)}</td>
              <td className={num}>
                {p.answers
                  ? `${pct(p.answers.accuracy)} (n=${p.answers.items})`
                  : "–"}
              </td>
              <td className={num}>{pct(p.answers?.verified_rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Failure({ f }: { f: FailureExample }) {
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm"
      data-failure={f.id}
    >
      <p className="text-xs text-slate-500">
        <span
          className={`mr-1.5 rounded px-1 font-medium ${
            f.kind === "incorrect"
              ? "bg-red-50 text-red-800"
              : "bg-amber-50 text-amber-900"
          }`}
        >
          {f.kind === "incorrect" ? "Wrong answer" : "Unverified sentences"}
        </span>
        {label(CATEGORY_LABELS, f.category)} ·{" "}
        <span className="font-mono">{f.id}</span>
      </p>
      <p className="font-medium">{f.question}</p>
      <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[max-content_1fr]">
        <dt className="text-slate-500">Gold</dt>
        <dd>{f.gold_answer}</dd>
        <dt className="text-slate-500">Answer</dt>
        <dd className="whitespace-pre-wrap break-words">{f.answer}</dd>
        <dt className="text-slate-500">Scored</dt>
        <dd>{f.why}</dd>
        {f.note && (
          <>
            <dt className="text-slate-500">Note</dt>
            <dd>{f.note}</dd>
          </>
        )}
      </dl>
    </li>
  );
}

export function EvalsPage() {
  const report = useReport();
  const history = useJson<TrendPoint[]>("/evals/history.json");
  if (report.status !== "ready") {
    return (
      <p className="text-slate-600" role="status">
        {report.status === "error"
          ? "The eval report couldn't be loaded."
          : "Loading the eval report…"}
      </p>
    );
  }
  const r = report.data;
  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Evals</h1>
        <p className="text-slate-700">
          Every number on this site comes from these runs of the production code
          (<code className="text-sm">packages/core</code>) over a fixed eval
          set. Retrieval run <Commit commit={r.commit} /> on{" "}
          {r.created_at.slice(0, 10)}, {r.split} split.
        </p>
      </header>

      <Section id="dataset" title="Dataset">
        <Dataset report={r} />
      </Section>

      {r.answers && (
        <Section id="answers" title="Answer quality">
          <AnswerMetrics answers={r.answers} />
        </Section>
      )}

      {r.judge && (
        <Section id="judge" title="Judge agreement">
          <JudgeAgreement judge={r.judge} />
        </Section>
      )}

      <Section id="retrieval" title="Retrieval configs">
        <p className="text-sm text-slate-700">
          {r.retrieval.default?.overall.n ?? "?"} scored dev items per config
          (items without evidence spans, such as unanswerable ones, are
          skipped). Compare any two live in the Pipeline Lab.
        </p>
        <ConfigTable configs={r.retrieval} />
      </Section>

      {history.status === "ready" && history.data.length > 0 && (
        <Section id="trend" title="Trend across releases">
          <Trend points={history.data} />
          <p className="text-xs text-slate-500">
            The eval set changed between releases (more and harder items), so
            rows with different item counts aren't directly comparable.
          </p>
        </Section>
      )}

      {r.answers?.failures && r.answers.failures.length > 0 && (
        <Section id="failures" title="Failure examples">
          <p className="text-sm text-slate-700">
            Every wrong answer in the run above, then every correct answer with
            a sentence the verifier couldn't verify. The notes on causes are
            Claude's, written after reading the cited passages.
          </p>
          <ul className="flex flex-col gap-3">
            {r.answers.failures.map((f) => (
              <Failure key={f.id} f={f} />
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
