// `pnpm eval:answers --split dev|test|all [--limit N] [--config default]
//   [--skip-judge] [--gate] [--write-baseline] [--report]`
// The production path end to end: retrieve (packages/core) → buildPrompt →
// generation on Groq (the Worker's Groq model and parameters) → deterministic
// sentence verification → the judges (a different model). Every LLM call is
// cached in evals/.cache/llm, so reruns are free and an interrupted run
// resumes. Writes evals/results/<ts>/{answers.jsonl, answers.json, answers.md}.
//   --limit N         a stratified subset (see selectItems)
//   --gate            fail if numeric EM or citation coverage drops vs
//                     evals/baseline_answers.json (same items)
//   --write-baseline  save this run's gated metrics as the baseline
//   --report          write the `answers` and `judge` sections of
//                     evals/reports/latest.json
// Exit codes: 1 gate or data error, 3 free-tier quota exhausted (rerun later).
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { parseArgs } from "node:util";
import {
  buildPrompt,
  ChunkStore,
  claimsOf,
  loadIndex,
  PROMPT_VERSION,
  parseInsufficient,
  type Reranker,
  type RetrievalConfig,
  retrieve,
  type SupportVerdict,
  verifyAnswer,
} from "@filinglens/core";
import {
  fsIndexSource,
  loadNodeEmbedder,
  loadNodeReranker,
} from "@filinglens/core/node";
import { GROQ } from "../../worker/src/providers/providers.config.ts";
import {
  type AnswerSummary,
  failureExamples,
  type ItemDetail,
  type ItemResult,
  itemCorrect,
  needsJudge,
  numericMatch,
  selectItems,
  summarize,
} from "./answerMetrics.ts";
import {
  EVALS_DIR,
  type GoldItem,
  loadGolden,
  type Split,
  sha256,
  writeJsonl,
} from "./dataset.ts";
import {
  type Calibration,
  CORRECTNESS_VERSION,
  calibrate,
  calibrationLine,
  gradeCorrectness,
  JUDGE_MODEL,
  judgeClient,
  promptSources,
  supportVerdicts,
} from "./judge.ts";
import { type ChatRequest, LlmClient, type Message, PROVIDERS } from "./llm.ts";
import { overlaps } from "./metrics.ts";
import { changedTexts, commit } from "./retrieval.ts";

const BASELINE_PATH = `${EVALS_DIR}/baseline_answers.json`;
const REPORT_PATH = `${EVALS_DIR}/reports/latest.json`;
/** Reviewer notes on failed items, keyed by item id (shown on /evals). */
const NOTES_PATH = `${EVALS_DIR}/failure_notes.json`;
/** Absolute drops that fail the gate (20 items: 2 numeric items, ~5% of sentences). */
const GATE = { numeric_em: 0.1, citation_coverage: 0.05 };
export const GENERATOR_MODEL = GROQ.model;

class QuotaError extends Error {}

/** The Worker's Groq request, non-streaming. */
export const generationRequest = (messages: Message[]): ChatRequest =>
  ({
    model: GROQ.model,
    messages,
    temperature: 0,
    max_tokens: GROQ.max_tokens,
    ...GROQ.extra,
  }) as ChatRequest;

async function orQuota<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof Error && /quota exhausted/.test(e.message)) {
      throw new QuotaError(e.message);
    }
    throw e;
  }
}

interface Baseline {
  split: string;
  items_sha256: string;
  numeric_em: number | null;
  citation_coverage: number | null;
  generator: string;
  prompt_version: string;
  commit: string | null;
}

const pct = (x: number | null) => (x === null ? "n/a" : (x * 100).toFixed(1));

function markdown(
  split: string,
  s: AnswerSummary,
  cal: Calibration | null,
  gateLine: string | null,
): string {
  const lines = [
    `### Answer eval: ${split} split, ${s.items} items (${GENERATOR_MODEL}, ${PROMPT_VERSION})`,
    "",
    "| metric | value | n |",
    "|---|---:|---:|",
    `| accuracy (EM, judge, or abstention per item) | ${pct(s.accuracy.value)} | ${s.accuracy.n} |`,
    `| numeric exact match | ${pct(s.numeric_em.value)} | ${s.numeric_em.n} |`,
    `| judge correctness (non-numeric) | ${pct(s.judge_correct.value)} | ${s.judge_correct.n} |`,
    `| false-premise correction | ${pct(s.false_premise_correction.value)} | ${s.false_premise_correction.n} |`,
    `| abstention precision / recall | ${pct(s.abstention.precision)} / ${pct(s.abstention.recall)} | ${s.abstention.unanswerable} |`,
    `| citation coverage | ${pct(s.citation_coverage)} | ${s.sentences} |`,
    `| citation precision | ${pct(s.citation_precision)} | |`,
    `| verified sentences | ${pct(s.verified_rate)} | ${s.sentences} |`,
    `| unsupported (judge) | ${pct(s.unsupported_rate)} | |`,
    "",
    `Latency p50/p95: retrieval ${s.latency_ms.retrieval.p50}/${s.latency_ms.retrieval.p95} ms, ` +
      `generation ${s.latency_ms.generation.p50}/${s.latency_ms.generation.p95} ms. ` +
      `Tokens: ${s.tokens.in} in, ${s.tokens.out} out.`,
  ];
  if (cal) lines.push("", `${calibrationLine(cal)}.`);
  if (gateLine) lines.push("", gateLine);
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<number> {
  const { values: args } = parseArgs({
    options: {
      config: { type: "string", default: "default" },
      split: { type: "string", default: "dev" },
      limit: { type: "string" },
      "skip-judge": { type: "boolean", default: false },
      gate: { type: "boolean", default: false },
      "write-baseline": { type: "boolean", default: false },
      report: { type: "boolean", default: false },
    },
  });
  const split = args.split as Split | "all";
  const moved = changedTexts();
  if (moved.length > 0) {
    console.error(
      `Doc texts changed since gold spans were anchored: ${moved.join(", ")}`,
    );
    return 1;
  }
  const items = selectItems(
    loadGolden(split),
    args.limit ? Number(args.limit) : undefined,
  );
  const itemsSha = sha256(items.map((i) => i.id).join(","));
  const config = JSON.parse(
    readFileSync(`${EVALS_DIR}/configs/${args.config}.json`, "utf8"),
  ) as RetrievalConfig;
  const useJudge = !args["skip-judge"];

  const source = fsIndexSource();
  const index = await loadIndex(source, config.strategy);
  const store = new ChunkStore(source, config.strategy);
  const embedder = await loadNodeEmbedder("wasm");
  const reranker: Reranker | undefined = config.rerank
    ? await loadNodeReranker("wasm")
    : undefined;
  const generator = new LlmClient(PROVIDERS.groq);
  const judge = useJudge ? judgeClient() : null;

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = `${EVALS_DIR}/results/${ts}`;
  mkdirSync(outDir, { recursive: true });
  const rows: ItemResult[] = [];
  const details: ItemDetail[] = [];

  let calibration: Calibration | null = null;
  try {
    for (const [i, item] of items.entries()) {
      const { row, detail } = await runItem(item, {
        config,
        index,
        store,
        embedder,
        reranker,
        generator,
        judge,
      });
      rows.push(row);
      details.push(detail);
      const ok = itemCorrect(row);
      console.log(
        `${String(i + 1).padStart(3)}/${items.length} ${item.id.padEnd(44)} ` +
          `${ok === null ? "-" : ok ? "✓" : "✗"} ${row.verified}/${row.sentences} verified`,
      );
    }
    if (judge) calibration = await orQuota(calibrate(judge, store, index.docs));
  } catch (e) {
    if (!(e instanceof QuotaError)) throw e;
    writeJsonl(`${outDir}/answers.jsonl`, details);
    console.error(
      `${e.message}\nStopped after ${rows.length}/${items.length} items; ` +
        "rerun the same command later (finished calls are cached).",
    );
    return 3;
  }

  const summary = summarize(rows);
  let exit = 0;
  let gateLine: string | null = null;
  if (args.gate) {
    if (!existsSync(BASELINE_PATH))
      throw new Error("no evals/baseline_answers.json");
    const base = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
    if (base.items_sha256 !== itemsSha || base.split !== split) {
      gateLine =
        "❌ Gate: the items differ from the baseline's; rerun with --write-baseline.";
      exit = 1;
    } else {
      const drops = {
        numeric_em: (base.numeric_em ?? 0) - (summary.numeric_em.value ?? 0),
        citation_coverage:
          (base.citation_coverage ?? 0) - (summary.citation_coverage ?? 0),
      };
      const ok =
        drops.numeric_em <= GATE.numeric_em + 1e-9 &&
        drops.citation_coverage <= GATE.citation_coverage + 1e-9;
      gateLine =
        `${ok ? "✅" : "❌"} Gate: numeric EM ${pct(summary.numeric_em.value)} vs ${pct(base.numeric_em)}, ` +
        `citation coverage ${pct(summary.citation_coverage)} vs ${pct(base.citation_coverage)} ` +
        `(limits: drops of ${pct(GATE.numeric_em)} and ${pct(GATE.citation_coverage)} points).`;
      if (!ok) exit = 1;
    }
    console.log(gateLine);
  }
  const run = commit();
  if (args["write-baseline"]) {
    const base: Baseline = {
      split,
      items_sha256: itemsSha,
      numeric_em: summary.numeric_em.value,
      citation_coverage: summary.citation_coverage,
      generator: GENERATOR_MODEL,
      prompt_version: PROMPT_VERSION,
      commit: run,
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(base, null, 2)}\n`);
    console.log("Wrote evals/baseline_answers.json");
  }

  const result = {
    created_at: new Date().toISOString(),
    commit: run,
    split,
    dataset: {
      items: items.length,
      sampled: args.limit ? "stratified by category" : "all",
      ids_sha256: itemsSha,
    },
    config: config.id,
    generator: { provider: "groq", model: GENERATOR_MODEL },
    prompt_version: PROMPT_VERSION,
    judge: useJudge
      ? { model: JUDGE_MODEL, correctness_version: CORRECTNESS_VERSION }
      : null,
    summary,
    failures: failureExamples(
      details,
      existsSync(NOTES_PATH)
        ? JSON.parse(readFileSync(NOTES_PATH, "utf8"))
        : {},
    ),
  };
  const md = markdown(split, summary, calibration, gateLine);
  console.log(`\n${md}`);
  writeJsonl(`${outDir}/answers.jsonl`, details);
  writeFileSync(
    `${outDir}/answers.json`,
    `${JSON.stringify({ ...result, calibration }, null, 2)}\n`,
  );
  writeFileSync(`${outDir}/answers.md`, md);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }
  if (args.report) {
    const report = JSON.parse(readFileSync(REPORT_PATH, "utf8"));
    report.answers = result;
    if (calibration) {
      report.judge = { created_at: result.created_at, ...calibration };
    }
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log("Wrote evals/reports/latest.json (answers, judge)");
  }
  console.log(`Results: evals/results/${ts}/`);
  return exit;
}

interface Deps {
  config: RetrievalConfig;
  index: Awaited<ReturnType<typeof loadIndex>>;
  store: ChunkStore;
  embedder: Awaited<ReturnType<typeof loadNodeEmbedder>>;
  reranker: Reranker | undefined;
  generator: LlmClient;
  judge: LlmClient | null;
}

async function runItem(item: GoldItem, d: Deps) {
  const res = await retrieve(d.index, item.question, d.config, {
    embedder: d.embedder,
    reranker: d.reranker,
    chunks: d.store,
  });
  const ids = res.top.map((c) => c.chunk_id);
  const sources = await promptSources(d.store, d.index.docs, ids);
  const gen = await orQuota(
    d.generator.chat(generationRequest(buildPrompt(item.question, sources))),
  );
  const answer = gen.content;
  const abstained = parseInsufficient(answer) !== null;
  const text = new Map(sources.map((s) => [s.chunk_id, s.chunk]));
  const checks = abstained
    ? []
    : verifyAnswer(answer, ids, (id) => text.get(id)?.text);

  let verdicts: SupportVerdict[] = [];
  let correctness: { correct: boolean; reason: string } | null = null;
  if (d.judge) {
    const judge = d.judge;
    if (!abstained && claimsOf(answer, ids).length > 0) {
      verdicts = await orQuota(
        supportVerdicts(judge, item.question, answer, sources),
      );
    }
    if (needsJudge(item)) {
      correctness = await orQuota(gradeCorrectness(judge, item, answer));
    }
  }

  let citations = 0;
  let precise = 0;
  const sentences = checks.map((c) => {
    const verdict = verdicts.find((v) => v.plain === c.plain);
    for (const cite of c.citations) {
      const chunk = text.get(cite.chunk_id);
      citations++;
      const onGold =
        chunk !== undefined && item.gold_spans.some((g) => overlaps(chunk, g));
      if (onGold || verdict?.supported) precise++;
    }
    return {
      text: c.text,
      status: c.status,
      reason: c.reason,
      missing: c.missing,
      cites: c.citations.map((x) => x.n),
      support: verdict
        ? { supported: verdict.supported, reason: verdict.reason }
        : null,
    };
  });

  const row: ItemResult = {
    id: item.id,
    category: item.category,
    answerable: item.answerable,
    abstained,
    numeric_em: item.gold_numeric
      ? !abstained &&
        numericMatch(answer, item.gold_numeric, item.category === "trend")
      : null,
    judge_correct: correctness ? correctness.correct : null,
    sentences: checks.length,
    cited: checks.filter((c) => c.citations.length > 0).length,
    verified: checks.filter((c) => c.status === "verified").length,
    support_judged: sentences.filter((s) => s.support !== null).length,
    unsupported: sentences.filter((s) => s.support?.supported === false).length,
    citations,
    precise_citations: precise,
    retrieval_ms: Math.round(res.timings.total_ms),
    generation_ms: gen.latency_ms ?? null,
    tokens_in: gen.usage.prompt_tokens,
    tokens_out: gen.usage.completion_tokens,
    provider: "groq",
  };
  const detail: ItemDetail & Record<string, unknown> = {
    ...row,
    question: item.question,
    gold_answer: item.gold_answer,
    gold_numeric: item.gold_numeric ?? null,
    answer,
    chunk_ids: ids,
    judge: correctness,
    sentences,
  };
  return { row, detail };
}

if (import.meta.main) process.exitCode = await main();
