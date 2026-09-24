import { describe, expect, it } from "vitest";
import type { GoldSpan } from "./dataset.ts";
import { countRelevant, mean, overlaps, scoreRanking } from "./metrics.ts";

const chunk = (doc_id: string, char_start: number, char_end: number) => ({
  doc_id,
  char_start,
  char_end,
});

describe("overlaps", () => {
  const gold: GoldSpan = { doc_id: "A", char_start: 100, char_end: 200 };
  it("needs 30 shared characters in the same doc", () => {
    expect(overlaps(chunk("A", 0, 130), gold)).toBe(true);
    expect(overlaps(chunk("A", 0, 129), gold)).toBe(false);
    expect(overlaps(chunk("B", 0, 500), gold)).toBe(false);
  });
  it("accepts full coverage of a span shorter than 30 characters", () => {
    const short = { doc_id: "A", char_start: 10, char_end: 20 };
    expect(overlaps(chunk("A", 0, 50), short)).toBe(true);
    expect(overlaps(chunk("A", 15, 50), short)).toBe(false);
  });
});

describe("scoreRanking", () => {
  // Two evidence groups; group "x" has two interchangeable spans.
  const gold: GoldSpan[] = [
    { doc_id: "A", char_start: 0, char_end: 50, group: "x" },
    { doc_id: "B", char_start: 0, char_end: 50, group: "x" },
    { doc_id: "A", char_start: 500, char_end: 550, group: "y" },
  ];
  const miss = chunk("C", 0, 100);

  it("counts groups for recall and the first hit for MRR", () => {
    const ranked = [miss, chunk("B", 0, 100), miss, miss, miss, miss];
    ranked.push(chunk("A", 480, 600));
    const s = scoreRanking(ranked, gold, 3);
    expect(s?.recall_at_5).toBe(0.5);
    expect(s?.recall_at_10).toBe(1);
    expect(s?.mrr_at_10).toBe(0.5);
  });

  it("gives nDCG 1 to an ideal ranking and less to a late one", () => {
    const ideal = [chunk("A", 0, 100), chunk("A", 500, 600)];
    expect(scoreRanking(ideal, gold, 2)?.ndcg_at_10).toBe(1);
    const late = [miss, miss, ...ideal];
    expect(scoreRanking(late, gold, 2)?.ndcg_at_10).toBeLessThan(0.7);
  });

  it("skips items without gold spans and scores empty rankings as 0", () => {
    expect(scoreRanking([miss], [], 0)).toBeNull();
    expect(scoreRanking([], gold, 3)?.recall_at_10).toBe(0);
  });

  it("counts relevant chunks in the index", () => {
    expect(
      countRelevant([chunk("A", 0, 40), miss, chunk("B", 10, 60)], gold),
    ).toBe(2);
  });
});

describe("mean", () => {
  it("averages and rounds to 4 decimals", () => {
    const a = { recall_at_5: 1, recall_at_10: 1, mrr_at_10: 1, ndcg_at_10: 1 };
    const b = {
      recall_at_5: 0,
      recall_at_10: 0,
      mrr_at_10: 1 / 3,
      ndcg_at_10: 0,
    };
    expect(mean([a, b])).toEqual({
      recall_at_5: 0.5,
      recall_at_10: 0.5,
      mrr_at_10: 0.6667,
      ndcg_at_10: 0.5,
      n: 2,
    });
  });
});
