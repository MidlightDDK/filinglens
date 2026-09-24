// LLM judges for the answer evals, and their calibration against human labels
// (evals/datasets/judge_labels.jsonl):
// - correctness (eval-only): does an answer agree with the item's gold answer?
// - support (packages/core, also behind /api/verify): does each cited
//   sentence follow from its cited sources?
// `pnpm eval:judge [--report]` reports agreement % and Cohen's kappa per task.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  buildSupportPrompt,
  type ChunkRecord,
  ChunkStore,
  claimsOf,
  type Docs,
  firstJsonObject,
  JUDGE_VERSION,
  type PromptSource,
  parseSupportVerdicts,
  type SupportVerdict,
} from "@filinglens/core";
import { fsIndexSource } from "@filinglens/core/node";
import { GROQ_JUDGE } from "../../worker/src/providers/providers.config.ts";
import { DATASETS_DIR, EVALS_DIR, readJsonl } from "./dataset.ts";
import { type ChatRequest, LlmClient, type Message, PROVIDERS } from "./llm.ts";

export const JUDGE_LABELS_PATH = `${DATASETS_DIR}/judge_labels.jsonl`;
/** Bump on any change to the correctness prompt. */
export const CORRECTNESS_VERSION = "correctness-v1";
/** Same model and parameters as the Worker's judge (providers.config.ts). */
export const JUDGE_MODEL = GROQ_JUDGE.model;

const CORRECTNESS_SYSTEM = `You grade an answer to a question about companies' SEC 10-K filings against a reference answer written by an analyst.

Grade "correct": true only if all of these hold:
1. The answer addresses the question that was asked.
2. Its key facts agree with the reference: numbers (rounding and equivalent units are fine, e.g. $193,737 million = $193.7 billion), companies, segments, fiscal years, and the direction of any change.
3. It covers every part the question asks for (for a comparison, both sides and which is higher; for "by how much", the difference). Extra correct detail is fine; extra detail that contradicts the reference is not.
4. If the reference says the question's premise is wrong, the answer must say so or clearly state the facts that contradict the premise. Answering as if the premise were true is incorrect.
5. Declining to answer (e.g. "INSUFFICIENT_EVIDENCE") is incorrect when the reference gives an answer.

Ignore citation markers like [2], style, and length.
Reply with JSON only: {"correct": true, "reason": "<at most 20 words>"}`;

export interface Graded {
  question: string;
  category: string;
  gold_answer: string;
}

export function correctnessPrompt(item: Graded, answer: string): Message[] {
  return [
    { role: "system", content: CORRECTNESS_SYSTEM },
    {
      role: "user",
      content:
        `QUESTION: ${item.question.trim()}\n` +
        `QUESTION TYPE: ${item.category.replace(/_/g, " ")}\n` +
        `REFERENCE ANSWER: ${item.gold_answer.trim()}\n` +
        `ANSWER TO GRADE: ${answer.trim()}`,
    },
  ];
}

export function parseCorrectness(
  text: string,
): { correct: boolean; reason: string } | null {
  const v = firstJsonObject(text) as { correct?: unknown; reason?: unknown };
  if (typeof v?.correct !== "boolean") return null;
  return {
    correct: v.correct,
    reason: typeof v.reason === "string" ? v.reason : "",
  };
}

/** Chat request for the judge model, with the Worker judge's parameters. */
export function judgeRequest(messages: Message[]): ChatRequest {
  return {
    model: GROQ_JUDGE.model,
    messages,
    temperature: 0,
    max_tokens: GROQ_JUDGE.max_tokens,
    ...GROQ_JUDGE.extra,
  };
}

export interface Agreement {
  n: number;
  /** Share of rows where the judge matches the human label. */
  agreement: number;
  /** Cohen's kappa; null when it is undefined (one class only). */
  kappa: number | null;
}

/** Agreement and Cohen's kappa for binary (judge, human) pairs. */
export function agreementStats(pairs: [boolean, boolean][]): Agreement {
  const n = pairs.length;
  if (n === 0) return { n, agreement: 0, kappa: null };
  const po = pairs.filter(([a, b]) => a === b).length / n;
  const judgeYes = pairs.filter(([a]) => a).length / n;
  const humanYes = pairs.filter(([, b]) => b).length / n;
  const pe = judgeYes * humanYes + (1 - judgeYes) * (1 - humanYes);
  const round = (x: number) => Math.round(x * 10000) / 10000;
  return {
    n,
    agreement: round(po),
    kappa: pe >= 1 ? null : round((po - pe) / (1 - pe)),
  };
}

export interface CorrectnessLabel {
  id: string;
  task: "correctness";
  item_id: string;
  question: string;
  category: string;
  gold_answer: string;
  answer: string;
  human_label: "correct" | "incorrect";
  rationale: string;
  /** `generated`: a real answer from the eval run; `edited`: altered by hand. */
  origin: "generated" | "edited";
}

export interface SupportLabel {
  id: string;
  task: "support";
  item_id: string;
  question: string;
  /** The whole answer, markers included: the judge sees all its claims. */
  answer: string;
  /** The sources `[n]` refers to, in order (ids in the default index). */
  chunk_ids: string[];
  /** The labelled sentence without markers (`Claim.plain`). */
  sentence: string;
  human_label: "supported" | "unsupported";
  rationale: string;
  origin: "generated" | "edited";
}

export type JudgeLabel = CorrectnessLabel | SupportLabel;

export interface Disagreement {
  id: string;
  human: string;
  judge: string;
  reason: string;
}

export interface Calibration {
  judge_model: string;
  correctness_version: string;
  support_version: string;
  correctness: Agreement & { disagreements: Disagreement[] };
  support: Agreement & { disagreements: Disagreement[]; unjudged: number };
}

/** Sources `[n]` refers to, loaded from the index (never from the label file). */
export async function promptSources(
  store: ChunkStore,
  docs: Docs,
  chunkIds: string[],
): Promise<PromptSource[]> {
  const chunks = await store.get(chunkIds);
  return chunkIds.map((chunk_id) => {
    const chunk = chunks.get(chunk_id) as ChunkRecord | undefined;
    const doc = chunk && docs[chunk.doc_id];
    if (!chunk || !doc) throw new Error(`unknown chunk ${chunk_id}`);
    return { chunk_id, chunk, doc };
  });
}

export async function supportVerdicts(
  judge: LlmClient,
  question: string,
  answer: string,
  sources: PromptSource[],
): Promise<SupportVerdict[]> {
  const ids = sources.map((s) => s.chunk_id);
  const claims = claimsOf(answer, ids);
  if (claims.length === 0) return [];
  const res = await judge.chat(
    judgeRequest(buildSupportPrompt(question, claims, sources)),
  );
  return parseSupportVerdicts(res.content, claims);
}

export async function gradeCorrectness(
  judge: LlmClient,
  item: Graded,
  answer: string,
): Promise<{ correct: boolean; reason: string } | null> {
  const res = await judge.chat(judgeRequest(correctnessPrompt(item, answer)));
  return parseCorrectness(res.content);
}

/** Runs both judges over the human labels. */
export async function calibrate(
  judge: LlmClient,
  store: ChunkStore,
  docs: Docs,
  labels: JudgeLabel[] = readJsonl<JudgeLabel>(JUDGE_LABELS_PATH),
): Promise<Calibration> {
  const cPairs: [boolean, boolean][] = [];
  const cDis: Disagreement[] = [];
  for (const row of labels) {
    if (row.task !== "correctness") continue;
    const v = await gradeCorrectness(judge, row, row.answer);
    const human = row.human_label === "correct";
    // An unparsable verdict counts as a disagreement.
    const verdict = v?.correct ?? !human;
    cPairs.push([verdict, human]);
    if (verdict !== human) {
      cDis.push({
        id: row.id,
        human: row.human_label,
        judge: v ? (v.correct ? "correct" : "incorrect") : "unparsable",
        reason: v?.reason ?? "",
      });
    }
  }

  const sPairs: [boolean, boolean][] = [];
  const sDis: Disagreement[] = [];
  let unjudged = 0;
  const groups = new Map<string, SupportLabel[]>();
  for (const row of labels) {
    if (row.task !== "support") continue;
    const key = JSON.stringify([row.question, row.answer, row.chunk_ids]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const rows of groups.values()) {
    const first = rows[0] as SupportLabel;
    const sources = await promptSources(store, docs, first.chunk_ids);
    const verdicts = await supportVerdicts(
      judge,
      first.question,
      first.answer,
      sources,
    );
    for (const row of rows) {
      const v = verdicts.find((x) => x.plain === row.sentence);
      const human = row.human_label === "supported";
      if (!v) unjudged++;
      const verdict = v?.supported ?? !human;
      sPairs.push([verdict, human]);
      if (verdict !== human) {
        sDis.push({
          id: row.id,
          human: row.human_label,
          judge: v ? (v.supported ? "supported" : "unsupported") : "no verdict",
          reason: v?.reason ?? "",
        });
      }
    }
  }
  return {
    judge_model: JUDGE_MODEL,
    correctness_version: CORRECTNESS_VERSION,
    support_version: JUDGE_VERSION,
    correctness: { ...agreementStats(cPairs), disagreements: cDis },
    support: { ...agreementStats(sPairs), disagreements: sDis, unjudged },
  };
}

export const judgeClient = () =>
  new LlmClient({ ...PROVIDERS.groq, name: "groq-judge" });

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function calibrationLine(c: Calibration): string {
  const k = (x: number | null) => (x === null ? "n/a" : x.toFixed(2));
  return (
    `Judge ${c.judge_model}: correctness agreement ${pct(c.correctness.agreement)} ` +
    `(kappa ${k(c.correctness.kappa)}, n=${c.correctness.n}); support agreement ` +
    `${pct(c.support.agreement)} (kappa ${k(c.support.kappa)}, n=${c.support.n})`
  );
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      report: { type: "boolean", default: false },
      strategy: { type: "string", default: "structure" },
    },
  });
  const source = fsIndexSource();
  const docs = await source.json<Docs>(`${args.strategy}/docs.json`);
  const store = new ChunkStore(source, args.strategy as string);
  const result = await calibrate(judgeClient(), store, docs);
  console.log(calibrationLine(result));
  for (const d of [
    ...result.correctness.disagreements,
    ...result.support.disagreements,
  ]) {
    console.log(`  ${d.id}: human ${d.human}, judge ${d.judge} (${d.reason})`);
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = `${EVALS_DIR}/results/${ts}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/judge.json`, `${JSON.stringify(result, null, 2)}\n`);
  if (args.report) {
    const path = `${EVALS_DIR}/reports/latest.json`;
    const report = JSON.parse(readFileSync(path, "utf8"));
    report.judge = { created_at: new Date().toISOString(), ...result };
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    console.log("Wrote evals/reports/latest.json (judge)");
  }
  console.log(`Results: evals/results/${ts}/judge.json`);
}

if (import.meta.main) await main();
