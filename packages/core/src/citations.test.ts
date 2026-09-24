import { describe, expect, it } from "vitest";
import { parseCitations, segmentMarkers, splitSentences } from "./citations.ts";

const sentences = (text: string) =>
  splitSentences(text).map((s) => text.slice(s.start, s.end));

describe("splitSentences", () => {
  it("keeps decimals and dollar amounts inside a sentence", () => {
    expect(
      sentences("Revenue was $1.2 billion. Margin rose to 45.3% in FY2025."),
    ).toEqual(["Revenue was $1.2 billion.", "Margin rose to 45.3% in FY2025."]);
  });

  it("does not split after abbreviations", () => {
    expect(
      sentences(
        "Sales in the U.S. grew 5% [1]. Apple Inc. sells devices, e.g. iPhone [2].",
      ),
    ).toEqual([
      "Sales in the U.S. grew 5% [1].",
      "Apple Inc. sells devices, e.g. iPhone [2].",
    ]);
  });

  it("keeps markers placed after the period with their sentence", () => {
    expect(sentences("Net sales fell. [3][4] Costs rose. [5]")).toEqual([
      "Net sales fell. [3][4]",
      "Costs rose. [5]",
    ]);
  });

  it("ends a sentence at a cited abbreviation", () => {
    expect(sentences("It sells in the U.S. [1] It also exports.")).toEqual([
      "It sells in the U.S. [1]",
      "It also exports.",
    ]);
  });

  it("splits lines and drops list bullets", () => {
    expect(
      sentences("Two drivers:\n- Services grew [1]\n2. iPhone fell [2].\n\n"),
    ).toEqual(["Two drivers:", "Services grew [1]", "iPhone fell [2]."]);
  });

  it("returns offsets into the original text", () => {
    const text = "  Ab cd. Ef gh.";
    expect(splitSentences(text)).toEqual([
      { start: 2, end: 8 },
      { start: 9, end: 15 },
    ]);
  });
});

describe("parseCitations", () => {
  const ids = ["c1", "c2", "c3"];

  it("maps markers to chunk ids and strips them", () => {
    expect(parseCitations("Revenue rose 8% [2][3].", ids)).toEqual({
      plain: "Revenue rose 8%.",
      citations: [
        { n: 2, chunk_id: "c2" },
        { n: 3, chunk_id: "c3" },
      ],
      invalid: [],
    });
  });

  it("accepts comma lists, dedupes, and drops markers outside SOURCES", () => {
    expect(parseCitations("X [1, 1] and Y [4][0].", ids)).toEqual({
      plain: "X and Y.",
      citations: [{ n: 1, chunk_id: "c1" }],
      invalid: [4, 0],
    });
  });
});

describe("segmentMarkers", () => {
  it("splits text and markers", () => {
    expect(segmentMarkers("A [1][2, 3] b")).toEqual([
      { type: "text", text: "A " },
      { type: "cite", n: 1 },
      { type: "cite", n: 2 },
      { type: "cite", n: 3 },
      { type: "text", text: " b" },
    ]);
  });
});
