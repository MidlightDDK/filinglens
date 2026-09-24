import { describe, expect, it } from "vitest";
import { rowToItem } from "./review.ts";

const row = {
  id: "hand-1",
  category: "unanswerable",
  question: "What revenue does Apple expect for fiscal year 2027?",
  gold_answer: "The filings give no guidance.",
  answerable: "no",
  companies: "aapl",
  fiscal_years: "FY2027",
  evidence: "",
};

describe("rowToItem", () => {
  it("parses an unanswerable row without evidence", () => {
    expect(rowToItem(row, "handwritten")).toMatchObject({
      id: "hand-1",
      companies: ["AAPL"],
      fiscal_years: [2027],
      answerable: false,
      gold_spans: [],
      source: "handwritten",
    });
  });

  it("parses the optional numeric answer", () => {
    const it = rowToItem(
      { ...row, gold_value: "$1,234.5", gold_unit: "", gold_tolerance: "1" },
      "handwritten",
    );
    expect(it.gold_numeric).toEqual({
      value: 1234.5,
      unit: "USD",
      tolerance: 1,
    });
  });

  it("rejects invalid rows", () => {
    expect(() =>
      rowToItem({ ...row, category: "trivia" }, "handwritten"),
    ).toThrow(/category/);
    expect(() =>
      rowToItem({ ...row, answerable: "yes" }, "handwritten"),
    ).toThrow(/answerable = no/);
    expect(() =>
      rowToItem(
        { ...row, category: "lookup", answerable: "yes" },
        "handwritten",
      ),
    ).toThrow(/evidence/);
    expect(() =>
      rowToItem({ ...row, evidence: "no doc id here" }, "handwritten"),
    ).toThrow(/DOC_ID/);
  });
});
