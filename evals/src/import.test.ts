import { describe, expect, it } from "vitest";
import type { GoldItem } from "./dataset.ts";
import { assignSplits } from "./import.ts";

const item = (id: string, category: GoldItem["category"] = "lookup") => ({
  id,
  question: "q",
  category,
  companies: [],
  fiscal_years: [],
  answerable: true,
  gold_answer: "a",
  gold_spans: [],
  source: "handwritten" as const,
});

describe("assignSplits", () => {
  it("splits each category 60/40", () => {
    const items = [
      ...Array.from({ length: 10 }, (_, i) => item(`l${i}`)),
      ...Array.from({ length: 5 }, (_, i) => item(`t${i}`, "trend")),
    ];
    const out = assignSplits(items, new Map());
    const count = (c: string, s: string) =>
      out.filter((it) => it.category === c && it.split === s).length;
    expect([count("lookup", "dev"), count("lookup", "test")]).toEqual([6, 4]);
    expect([count("trend", "dev"), count("trend", "test")]).toEqual([3, 2]);
  });

  it("never moves an existing item and is order-independent", () => {
    const items = Array.from({ length: 8 }, (_, i) => item(`x${i}`));
    const first = assignSplits(items, new Map());
    const previous = new Map(first.map((it) => [it.id, it.split]));
    const more = [...items, item("y1"), item("y2")].reverse();
    const second = assignSplits(more, previous);
    for (const it of first) {
      expect(second.find((s) => s.id === it.id)?.split).toBe(it.split);
    }
    expect(assignSplits([...items].reverse(), new Map())).toEqual(first);
  });
});
