// Answer metrics (see .claude/rules/evals.md). Pure functions over per-item
// results, so they are unit-tested apart from any LLM call.
import { extractNumbers, MARKER, type NumberMention } from "@filinglens/core";
import {
  CATEGORIES,
  type GoldItem,
  type GoldNumeric,
  sha256,
} from "./dataset.ts";
import { percentile } from "./metrics.ts";

function unitFits(n: NumberMention, unit: string): boolean {
  if (unit === "%" || unit === "percentage points") {
    return n.percent || (!n.currency && !n.scaled); // "11.7 points"
  }
  if (unit === "USD") return !n.percent;
  return !n.percent && !n.scaled; // USD/share, USD per USD
}

/**
 * Numeric exact match: the answer states the gold value within its tolerance
 * (signs ignored; prose carries direction in words). With `change`, for trend
 * questions ("How did X change?") whose gold is a percent change, stating
 * both endpoints also counts: "from $8,249 million to $14,265 million"
 * determines the 72.9% rise.
 */
export function numericMatch(
  answer: string,
  gold: GoldNumeric,
  change = false,
): boolean {
  const target = Math.abs(gold.value);
  const slack = gold.tolerance + target * 1e-9;
  const numbers = extractNumbers(answer.replace(MARKER, " "));
  if (
    numbers.some(
      (n) =>
        unitFits(n, gold.unit) && Math.abs(Math.abs(n.value) - target) <= slack,
    )
  ) {
    return true;
  }
  if (!change || gold.unit !== "%") return false;
  const amounts = numbers
    .filter((n) => !n.percent)
    .map((n) => Math.abs(n.value));
  return amounts.some((a, i) =>
    amounts.slice(i + 1).some((b) => {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      if (lo === 0) return false;
      const up = ((hi - lo) / lo) * 100;
      const down = ((hi - lo) / hi) * 100;
      return Math.abs(up - target) <= slack || Math.abs(down - target) <= slack;
    }),
  );
}

/** Items the correctness judge grades: non-numeric answerable items and false premises. */
export const needsJudge = (item: GoldItem) =>
  item.category === "false_premise" ||
  (item.answerable && item.gold_numeric === undefined);

/**
 * Up to `limit` items, stratified: categories take turns, each in a fixed
 * pseudo-random order (sha256 of the id), so a smaller limit is a subset of a
 * larger one and cached LLM calls carry over.
 */
export function selectItems(items: GoldItem[], limit?: number): GoldItem[] {
  if (!limit || limit >= items.length) return items;
  const order = (a: GoldItem, b: GoldItem) =>
    sha256(a.id) < sha256(b.id) ? -1 : 1;
  const queues = CATEGORIES.map((c) =>
    items.filter((i) => i.category === c).sort(order),
  );
  const out: GoldItem[] = [];
  for (let round = 0; out.length < limit; round++) {
    const next = queues.map((q) => q[round]).filter((i) => i !== undefined);
    if (next.length === 0) break;
    out.push(...next.slice(0, limit - out.length));
  }
  return out;
}

export interface ItemResult {
  id: string;
  category: string;
  answerable: boolean;
  abstained: boolean;
  /** Numeric exact match; null without a gold number. */
  numeric_em: boolean | null;
  /** Correctness judge; null when not judged. */
  judge_correct: boolean | null;
  sentences: number;
  /** Sentences with at least one valid citation. */
  cited: number;
  verified: number;
  /** Cited sentences the support judge ruled on, and those it rejected. */
  support_judged: number;
  unsupported: number;
  /** (sentence, cited chunk) pairs, and those overlapping gold or judged supported. */
  citations: number;
  precise_citations: number;
  retrieval_ms: number;
  generation_ms: number | null;
  tokens_in: number;
  tokens_out: number;
  provider: string;
}

/** The item's headline outcome: EM for numbers, abstention for unanswerable, else the judge. */
export function itemCorrect(r: ItemResult): boolean | null {
  if (!r.answerable) return r.abstained;
  if (r.category === "false_premise") return r.judge_correct;
  return r.numeric_em ?? r.judge_correct;
}

const rate = (num: number, den: number) =>
  den > 0 ? Math.round((num / den) * 10000) / 10000 : null;
const share = (rows: ItemResult[], f: (r: ItemResult) => boolean | null) => {
  const vals = rows.map(f).filter((v) => v !== null);
  return {
    value: rate(vals.filter(Boolean).length, vals.length),
    n: vals.length,
  };
};
const sum = (rows: ItemResult[], f: (r: ItemResult) => number) =>
  rows.reduce((s, r) => s + f(r), 0);

export function summarize(rows: ItemResult[]) {
  const unanswerable = rows.filter((r) => !r.answerable);
  const abstained = rows.filter((r) => r.abstained);
  const answered = rows.filter((r) => !r.abstained);
  const gen = rows
    .map((r) => r.generation_ms)
    .filter((v): v is number => v !== null);
  const ret = rows.map((r) => r.retrieval_ms);
  const perCategory: Record<string, { accuracy: number | null; n: number }> =
    {};
  for (const c of CATEGORIES) {
    const inCat = rows.filter((r) => r.category === c);
    if (inCat.length === 0) continue;
    const s = share(inCat, itemCorrect);
    perCategory[c] = { accuracy: s.value, n: s.n };
  }
  const providers: Record<string, number> = {};
  for (const r of rows)
    providers[r.provider] = (providers[r.provider] ?? 0) + 1;
  return {
    items: rows.length,
    accuracy: share(rows, itemCorrect),
    numeric_em: share(rows, (r) => r.numeric_em),
    judge_correct: share(
      rows.filter((r) => r.category !== "false_premise"),
      (r) => r.judge_correct,
    ),
    false_premise_correction: share(
      rows.filter((r) => r.category === "false_premise"),
      (r) => r.judge_correct,
    ),
    abstention: {
      precision: rate(
        abstained.filter((r) => !r.answerable).length,
        abstained.length,
      ),
      recall: rate(
        unanswerable.filter((r) => r.abstained).length,
        unanswerable.length,
      ),
      abstained: abstained.length,
      unanswerable: unanswerable.length,
    },
    sentences: sum(answered, (r) => r.sentences),
    citation_coverage: rate(
      sum(answered, (r) => r.cited),
      sum(answered, (r) => r.sentences),
    ),
    citation_precision: rate(
      sum(answered, (r) => r.precise_citations),
      sum(answered, (r) => r.citations),
    ),
    verified_rate: rate(
      sum(answered, (r) => r.verified),
      sum(answered, (r) => r.sentences),
    ),
    unsupported_rate: rate(
      sum(answered, (r) => r.unsupported),
      sum(answered, (r) => r.support_judged),
    ),
    per_category: perCategory,
    latency_ms: {
      retrieval: { p50: percentile(ret, 0.5), p95: percentile(ret, 0.95) },
      generation: { p50: percentile(gen, 0.5), p95: percentile(gen, 0.95) },
    },
    tokens: {
      in: sum(rows, (r) => r.tokens_in),
      out: sum(rows, (r) => r.tokens_out),
    },
    providers,
  };
}

export type AnswerSummary = ReturnType<typeof summarize>;
