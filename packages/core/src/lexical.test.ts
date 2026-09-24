import { describe, expect, it } from "vitest";
import {
  buildLexicalIndex,
  loadLexicalIndex,
  searchLexical,
  tokenize,
} from "./lexical.ts";

describe("tokenize", () => {
  it("lowercases, drops stopwords and single letters, joins digit groups", () => {
    expect(tokenize("The revenue of $1,234.5 million in U.S. markets")).toEqual(
      ["revenue", "1234.5", "million", "market"],
    );
  });

  it("strips plurals conservatively", () => {
    expect(
      tokenize("taxes losses businesses branches companies sales status gas"),
    ).toEqual([
      "tax",
      "loss",
      "business",
      "branch",
      "company",
      "sale",
      "status",
      "gas",
    ]);
  });
});

describe("BM25", () => {
  const texts = [
    "Apple iPhone net sales increased",
    "Data center revenue grew strongly; data center demand",
    "Risk factors: supply chain risks",
    "Net sales by category: iPhone, Mac, iPad",
  ];
  const index = loadLexicalIndex(buildLexicalIndex(texts));

  it("ranks by BM25 score with deterministic ties", () => {
    const hits = searchLexical(index, "data center revenue", null, 10);
    expect(hits.map((h) => h.row)).toEqual([1]);
    const sales = searchLexical(index, "iPhone net sales", null, 10);
    expect(sales.map((h) => h.row)).toEqual([0, 3]);
    expect(sales[0]?.score).toBeGreaterThan(sales[1]?.score ?? 0);
  });

  it("respects the allowed-row mask and k", () => {
    const allowed = Uint8Array.from([0, 1, 1, 1]);
    expect(
      searchLexical(index, "iPhone net sales", allowed, 10).map((h) => h.row),
    ).toEqual([3]);
    expect(searchLexical(index, "iPhone net sales", null, 1)).toHaveLength(1);
  });

  it("builds identical output for identical input", () => {
    expect(JSON.stringify(buildLexicalIndex(texts))).toEqual(
      JSON.stringify(buildLexicalIndex([...texts])),
    );
  });

  it("does not trip over Object prototype names", () => {
    expect(searchLexical(index, "constructor __proto__", null, 5)).toEqual([]);
  });
});
