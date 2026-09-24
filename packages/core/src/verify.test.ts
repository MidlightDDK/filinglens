import { describe, expect, it } from "vitest";
import {
  answerSentences,
  extractNumbers,
  highlightSpan,
  numbersMatch,
  verifyAnswer,
  verifySentence,
  verifySentences,
  withJudge,
} from "./verify.ts";

const values = (text: string) => extractNumbers(text).map((n) => n.value);
const one = (text: string) => {
  const [n] = extractNumbers(text);
  if (!n) throw new Error(`no number in ${text}`);
  return n;
};

describe("extractNumbers", () => {
  it("normalizes commas, $, %, and scale words", () => {
    expect(
      values("Revenue was $1.2 billion, up 12.5% to 3,456 units."),
    ).toEqual([1.2e9, 12.5, 3456]);
    expect(values("$391,035 million and $60 thousand")).toEqual([
      391_035e6, 60e3,
    ]);
    expect(values("It rose 7.5 percentage points (about 8 percent).")).toEqual([
      7.5, 8,
    ]);
  });

  it("reads parentheses and minus signs as negatives", () => {
    expect(values("Other income (expense) | (1,234) | -56 | −7%")).toEqual([
      -1234, -56, -7,
    ]);
    const n = one("a change of (5)%");
    expect(n).toMatchObject({ value: -5, percent: true, raw: "(5)%" });
  });

  it("does not treat prose parentheses as a sign", () => {
    expect(one("(including $5 million of fees").value).toBe(5e6);
    expect(one("fees of $5 million)").raw).toBe("$5 million");
  });

  it("reads scale letters glued to the number", () => {
    expect(values("$1.2B and $500M and $40K")).toEqual([1.2e9, 500e6, 40e3]);
  });

  it("flags currency, scale, and per-share values", () => {
    expect(one("$6.08 per diluted share")).toMatchObject({
      value: 6.08,
      currency: true,
      scaled: false,
      perShare: true,
    });
    expect(one("$1.2 billion")).toMatchObject({
      scaled: true,
      perShare: false,
    });
  });

  it("sets the rounding tolerance from the written precision", () => {
    expect(one("$193.7 billion").tolerance).toBeCloseTo(0.05e9);
    expect(one("46.9%").tolerance).toBeCloseTo(0.05);
    expect(one("12,000").tolerance).toBe(0.5);
  });

  it("skips references written with Unicode hyphens", () => {
    expect(values("The 10‑K and Form 8–K; Coca‑Cola 2")).toEqual([2]);
  });

  it("skips years, dates, references, and digits inside words", () => {
    expect(
      values(
        "In fiscal 2025 (ended September 27, 2025), Item 7 and Note 12 of the Form 10-K, " +
          "FY2025, H100, COVID-19, Rule 10b5-1, 1A, 4th, and 2024-2025.",
      ),
    ).toEqual([]);
  });

  it("reads both ends of a range", () => {
    expect(values("10–15% and 3-5 years")).toEqual([10, 15, 3, 5]);
  });

  it("keeps money that looks like a year", () => {
    expect(values("$2,025 million and 2,025 units and $2025")).toEqual([
      2025e6, 2025, 2025,
    ]);
  });

  it("reads table cells", () => {
    expect(
      values("Total net sales | $416,161% | 6 |  | $391,035% | 2 |"),
    ).toEqual([416_161, 6, 391_035, 2]);
  });
});

describe("numbersMatch", () => {
  const match = (claim: string, source: string) =>
    extractNumbers(source).some((s) => numbersMatch(one(claim), s));

  it("matches exact and rounded values", () => {
    expect(match("$193,737 million", "Data Center | $ 193,737 |")).toBe(true);
    expect(match("$193.7 billion", "Data Center | 193,737 |")).toBe(true);
    expect(match("$194 billion", "Data Center | 193,737 |")).toBe(true);
    expect(match("$200 billion", "Data Center | 193,737 |")).toBe(false);
    expect(match("$193.8 billion", "Data Center | 193,737 |")).toBe(false);
  });

  it("does not let the claim be more precise than the source", () => {
    expect(match("47%", "margin of 46.9%")).toBe(true);
    expect(match("46.9%", "margin of 47%")).toBe(false);
  });

  it("keeps percents and amounts apart", () => {
    expect(match("12%", "grew 12% to $5.0 billion")).toBe(true);
    expect(match("12%", "Gross margin percentage | 12 |")).toBe(true);
    expect(match("$12 million", "grew 12%")).toBe(false);
    expect(match("12%", "$12 million")).toBe(false);
  });

  it("treats a dollar cell with a stray % as an amount", () => {
    expect(match("$416,161 million", "Total | $416,161% | 6 |")).toBe(true);
  });

  it("ignores signs", () => {
    expect(match("a loss of $1,234 million", "Net loss | (1,234) |")).toBe(
      true,
    );
  });

  it("matches per-share values unscaled", () => {
    expect(match("$6.08", "Diluted | $ 6.08 | $ 6.11")).toBe(true);
    expect(match("$6.10", "Diluted | $ 6.08 | $ 6.11")).toBe(false);
  });
});

describe("verifySentence", () => {
  const texts: Record<string, string> = {
    a: "Data Center revenue was $115.2 billion in fiscal year 2025, up 142%.",
    b: "Gaming revenue | 11,350 | 10,447 |",
  };
  const ids = ["a", "b"];
  const text = (id: string) => texts[id];

  it("verifies a cited sentence whose numbers are in its sources", () => {
    const c = verifySentence(
      "Data Center revenue was $115.2 billion, up 142% [1].",
      ids,
      text,
    );
    expect(c).toMatchObject({
      status: "verified",
      reason: "ok",
      numbers: ["$115.2 billion", "142%"],
      missing: [],
    });
  });

  it("verifies a cited sentence without numbers", () => {
    expect(
      verifySentence("Data Center drove the growth [1].", ids, text).status,
    ).toBe("verified");
  });

  it("flags an uncited sentence", () => {
    expect(
      verifySentence("Data Center revenue was $115.2 billion.", ids, text),
    ).toMatchObject({ status: "unverified", reason: "no_citation" });
  });

  it("flags a number missing from the cited source", () => {
    const c = verifySentence(
      "Gaming revenue was $11,350 million, up 9% [2].",
      ids,
      text,
    );
    expect(c).toMatchObject({
      status: "unverified",
      reason: "number_not_found",
      missing: ["9%"],
    });
  });

  it("only searches the cited sources", () => {
    expect(
      verifySentence("Gaming revenue was $11,350 million [1].", ids, text)
        .missing,
    ).toEqual(["$11,350 million"]);
  });

  it("drops markers outside SOURCES", () => {
    expect(verifySentence("Gaming grew [3].", ids, text)).toMatchObject({
      status: "unverified",
      invalid: [3],
      citations: [],
    });
  });
});

describe("verifySentences", () => {
  const texts: Record<string, string> = {
    a: "Diluted | $ 7.46 | $ 6.08 |",
    b: "Diluted earnings per share | $ 7.17 | $ 5.53 |",
    c: "Operating income | 36,852 | 68,593 | Services 109,158 | Total 416,161",
  };
  const ids = ["a", "b", "c"];
  const text = (id: string) => texts[id];
  const check = (...sentences: string[]) =>
    verifySentences(sentences, ids, text).map((c) => [
      c.status,
      c.derived,
      c.missing,
    ]);

  it("derives differences, sums, and ratios from found numbers in the answer", () => {
    expect(
      check(
        "Apple earned $7.46 and Amazon $7.17 per share [1][2].",
        "Apple's was $0.29 higher [1][2].",
      ),
    ).toEqual([
      ["verified", [], []],
      ["verified", ["$0.29"], []],
    ]);
    expect(
      check(
        "Operating income rose from $36.852 billion to $68.593 billion [3].",
        "That is $31.741 billion, or 86.1% more [3].",
        "Services were 26.2% of $416,161 million of sales, $109,158 million [3].",
      ).map(([s]) => s),
    ).toEqual(["verified", "verified", "verified"]);
  });

  it("derives percentage points only from percents", () => {
    const pts = verifySentences(
      ["Margins were 35.4% and 23.7% [1].", "A gap of 11.7 points [1]."],
      ["a"],
      () => "35.4% | 23.7%",
    );
    expect(pts[1]).toMatchObject({
      status: "verified",
      derived: ["11.7 points"],
    });
  });

  it("does not derive from numbers that were not found, or from passage cells alone", () => {
    expect(check("Apple's was $0.29 higher [1][2].")).toEqual([
      ["unverified", [], ["$0.29"]],
    ]);
    expect(
      check(
        "Apple earned $7.46 and Amazon $9.99 per share [1][2].",
        "Apple's was $2.53 lower [1][2].",
      ),
    ).toEqual([
      ["unverified", [], ["$9.99"]],
      ["unverified", [], ["$2.53"]],
    ]);
  });
});

describe("verifyAnswer", () => {
  it("checks each rendered sentence", () => {
    const answer =
      "**Revenue** rose to $5 million [1].\n- Costs fell [2].\n- Margins held.";
    expect(answerSentences(answer)).toEqual([
      "Revenue rose to $5 million [1].",
      "Costs fell [2].",
      "Margins held.",
    ]);
    const checks = verifyAnswer(answer, ["a", "b"], () => "sales of 5,000");
    expect(checks.map((c) => c.status)).toEqual([
      "verified",
      "verified",
      "unverified",
    ]);
  });
});

describe("withJudge", () => {
  it("lets the judge mark a sentence unsupported", () => {
    expect(withJudge({ status: "verified" }, false)).toBe("unsupported");
    expect(withJudge({ status: "unverified" }, true)).toBe("unverified");
    expect(withJudge({ status: "verified" }, undefined)).toBe("verified");
  });
});

describe("highlightSpan", () => {
  const chunk =
    "Total net sales were $391,035 million in 2024. Services net sales increased due to advertising. iPhone net sales decreased.";

  it("prefers the chunk sentence with the matching number", () => {
    const span = highlightSpan("Net sales were $391,035 million [1].", chunk);
    expect(span && chunk.slice(span.start, span.end)).toBe(
      "Total net sales were $391,035 million in 2024.",
    );
  });

  it("falls back to the largest word overlap", () => {
    const span = highlightSpan("Advertising lifted services sales [1].", chunk);
    expect(span && chunk.slice(span.start, span.end)).toBe(
      "Services net sales increased due to advertising.",
    );
  });

  it("finds a rounded number by value", () => {
    const table =
      "Revenue by segment. Data Center | 193,737 | 115,186 | Gaming | 11,350 |";
    const span = highlightSpan("Data Center made $193.7 billion [1].", table);
    expect(span && table.slice(span.start, span.end)).toContain("193,737");
  });

  it("returns null without overlap", () => {
    expect(highlightSpan("Unrelated words [1].", chunk)).toBeNull();
  });
});
