import { describe, expect, it } from "vitest";
import {
  type ItemResult,
  itemCorrect,
  needsJudge,
  numericMatch,
  selectItems,
  summarize,
} from "./answerMetrics.ts";
import type { GoldItem } from "./dataset.ts";
import { agreementStats, parseCorrectness } from "./judge.ts";

describe("numericMatch", () => {
  it("matches amounts in any written scale within tolerance", () => {
    const gold = { value: 48_836_000_000, unit: "USD", tolerance: 393_895_000 };
    expect(numericMatch("Higher by $48,836 million [2].", gold)).toBe(true);
    expect(numericMatch("about $48.8 billion", gold)).toBe(true);
    expect(numericMatch("about $47 billion", gold)).toBe(false);
    expect(numericMatch("48.8% higher", gold)).toBe(false);
  });

  it("matches percents and points, ignoring sign and markers", () => {
    const pct = { value: -5.2, unit: "%", tolerance: 0.5 };
    expect(numericMatch("It fell 5.4% [1].", pct)).toBe(true);
    expect(numericMatch("It fell 5 [1].", pct)).toBe(true);
    expect(numericMatch("It fell $5.2 million [1].", pct)).toBe(false);
    const pts = { value: 11.7, unit: "percentage points", tolerance: 0.3 };
    expect(numericMatch("AWS, by about 11.7 points.", pts)).toBe(true);
  });

  it("matches per-share values unscaled", () => {
    const eps = { value: 0.55, unit: "USD/share", tolerance: 0.005 };
    expect(numericMatch("Apple's $6.08 vs $5.53: $0.55 more.", eps)).toBe(true);
    expect(numericMatch("$0.55 million", eps)).toBe(false);
  });

  it("does not count citation markers as numbers", () => {
    const gold = { value: 2, unit: "%", tolerance: 0.1 };
    expect(numericMatch("Sales grew [2].", gold)).toBe(false);
  });
});

const item = (id: string, category: GoldItem["category"], extra = {}) =>
  ({
    id,
    question: "q",
    category,
    companies: [],
    fiscal_years: [],
    answerable: category !== "unanswerable",
    gold_answer: "a",
    gold_spans: [],
    source: "handwritten",
    split: "dev",
    ...extra,
  }) as GoldItem;

describe("needsJudge", () => {
  it("judges non-numeric answerable items and false premises", () => {
    expect(needsJudge(item("a", "lookup"))).toBe(true);
    const numeric = { gold_numeric: { value: 1, unit: "%", tolerance: 0 } };
    expect(needsJudge(item("b", "lookup", numeric))).toBe(false);
    expect(needsJudge(item("c", "false_premise", numeric))).toBe(true);
    expect(needsJudge(item("d", "unanswerable"))).toBe(false);
  });
});

describe("selectItems", () => {
  const items = [
    ...["l1", "l2", "l3"].map((id) => item(id, "lookup")),
    ...["t1", "t2"].map((id) => item(id, "trend")),
    item("u1", "unanswerable"),
  ];

  it("takes categories in turn, and a smaller limit is a subset", () => {
    const four = selectItems(items, 4);
    expect(four.map((i) => i.category)).toEqual([
      "lookup",
      "trend",
      "unanswerable",
      "lookup",
    ]);
    const three = selectItems(items, 3).map((i) => i.id);
    expect(four.map((i) => i.id).slice(0, 3)).toEqual(three);
    expect(selectItems(items).length).toBe(6);
    expect(selectItems(items, 99).length).toBe(6);
  });
});

const row = (over: Partial<ItemResult>): ItemResult => ({
  id: "x",
  category: "lookup",
  answerable: true,
  abstained: false,
  numeric_em: null,
  judge_correct: null,
  sentences: 2,
  cited: 2,
  verified: 1,
  support_judged: 2,
  unsupported: 0,
  citations: 2,
  precise_citations: 2,
  retrieval_ms: 10,
  generation_ms: 100,
  tokens_in: 1000,
  tokens_out: 50,
  provider: "groq",
  ...over,
});

describe("itemCorrect and summarize", () => {
  it("uses EM for numbers, abstention for unanswerable, else the judge", () => {
    expect(itemCorrect(row({ numeric_em: false, judge_correct: true }))).toBe(
      false,
    );
    expect(itemCorrect(row({ judge_correct: true }))).toBe(true);
    expect(
      itemCorrect(
        row({ category: "unanswerable", answerable: false, abstained: true }),
      ),
    ).toBe(true);
    expect(
      itemCorrect(
        row({
          category: "false_premise",
          numeric_em: true,
          judge_correct: false,
        }),
      ),
    ).toBe(false);
  });

  it("aggregates answer, citation, abstention, and cost metrics", () => {
    const s = summarize([
      row({ id: "a", numeric_em: true }),
      row({
        id: "b",
        numeric_em: false,
        cited: 1,
        verified: 0,
        precise_citations: 1,
      }),
      row({ id: "c", category: "false_premise", judge_correct: true }),
      row({
        id: "d",
        category: "unanswerable",
        answerable: false,
        abstained: true,
        sentences: 0,
        cited: 0,
        verified: 0,
        support_judged: 0,
        citations: 0,
        precise_citations: 0,
      }),
      row({ id: "e", abstained: true, judge_correct: false, sentences: 9 }),
    ]);
    expect(s.accuracy).toEqual({ value: 0.6, n: 5 });
    expect(s.numeric_em).toEqual({ value: 0.5, n: 2 });
    expect(s.false_premise_correction).toEqual({ value: 1, n: 1 });
    expect(s.judge_correct).toEqual({ value: 0, n: 1 });
    expect(s.abstention).toEqual({
      precision: 0.5,
      recall: 1,
      abstained: 2,
      unanswerable: 1,
    });
    // Abstentions don't count toward sentence metrics.
    expect(s.sentences).toBe(6);
    expect(s.citation_coverage).toBe(0.8333);
    expect(s.citation_precision).toBe(0.8333);
    expect(s.verified_rate).toBe(0.3333);
    expect(s.unsupported_rate).toBe(0);
    expect(s.per_category.lookup).toEqual({ accuracy: 0.3333, n: 3 });
    expect(s.tokens).toEqual({ in: 5000, out: 250 });
    expect(s.providers).toEqual({ groq: 5 });
  });
});

describe("judge helpers", () => {
  it("computes agreement and Cohen's kappa", () => {
    const pairs: [boolean, boolean][] = [
      [true, true],
      [true, true],
      [false, false],
      [true, false],
    ];
    // po = 0.75; pe = 0.75*0.5 + 0.25*0.5 = 0.5; kappa = 0.5
    expect(agreementStats(pairs)).toEqual({
      n: 4,
      agreement: 0.75,
      kappa: 0.5,
    });
    expect(agreementStats([[true, true]]).kappa).toBeNull();
    expect(agreementStats([])).toEqual({ n: 0, agreement: 0, kappa: null });
  });

  it("parses correctness verdicts", () => {
    expect(
      parseCorrectness(
        '```json\n{"correct": false, "reason": "wrong FY"}\n```',
      ),
    ).toEqual({ correct: false, reason: "wrong FY" });
    expect(parseCorrectness('{"correct": "yes"}')).toBeNull();
  });
});
