import { describe, expect, it } from "vitest";
import {
  buildSupportPrompt,
  claimsOf,
  firstJsonObject,
  parseSupportVerdicts,
} from "./judge.ts";

const source = (chunk_id: string, text: string) => ({
  chunk_id,
  chunk: {
    text,
    doc_id: "AAPL-FY2025",
    item: "7",
    heading_path: ["Net Sales"],
    char_start: 0,
    char_end: text.length,
  },
  doc: {
    company: "Apple",
    ticker: "AAPL",
    aliases: [],
    fy: 2025,
    filing_date: "2025-10-31",
    url: "https://www.sec.gov/x",
  },
});

const answer =
  "Net sales were $416 billion [1]. Services grew [3][9]. Nothing else is known.";
const ids = ["a", "b", "c"];

describe("claimsOf", () => {
  it("keeps sentences with valid citations", () => {
    expect(claimsOf(answer, ids)).toEqual([
      { plain: "Net sales were $416 billion.", cites: [1] },
      { plain: "Services grew.", cites: [3] },
    ]);
  });
});

describe("buildSupportPrompt", () => {
  it("includes only cited sources, numbered as in the answer", () => {
    const sources = [
      source("a", "Net sales were $416,161 million."),
      source("b", "Unrelated."),
      source("c", "Services net sales increased 14%."),
    ];
    const [system, user] = buildSupportPrompt(
      " Q? ",
      claimsOf(answer, ids),
      sources,
    );
    expect(system?.content).toContain('"verdicts"');
    expect(user?.content).toContain(
      "[1] Apple (AAPL) | FY2025 10-K | Item 7 | Net Sales\nNet sales were $416,161 million.",
    );
    expect(user?.content).toContain("[3] Apple");
    expect(user?.content).not.toContain("Unrelated.");
    expect(user?.content).toContain(
      "QUESTION: Q?\n\nCLAIMS:\nCLAIM 1 (cites [1]): Net sales were $416 billion.\nCLAIM 2 (cites [3]): Services grew.",
    );
  });
});

describe("parseSupportVerdicts", () => {
  const claims = claimsOf(answer, ids);

  it("maps verdicts to claims, tolerating fences and prose", () => {
    const reply =
      'Here you go:\n```json\n{"verdicts":[{"claim":2,"supported":false,"reason":"no growth figure {}"},' +
      '{"claim":1,"supported":true,"reason":"rounded"}]}\n```';
    expect(parseSupportVerdicts(reply, claims)).toEqual([
      {
        plain: "Services grew.",
        supported: false,
        reason: "no growth figure {}",
      },
      {
        plain: "Net sales were $416 billion.",
        supported: true,
        reason: "rounded",
      },
    ]);
  });

  it("skips unknown claims, duplicates, and non-boolean verdicts", () => {
    const reply = JSON.stringify({
      verdicts: [
        { claim: 7, supported: true },
        { claim: 1, supported: "yes" },
        { claim: 2, supported: true },
        { claim: 2, supported: false },
      ],
    });
    expect(parseSupportVerdicts(reply, claims)).toEqual([
      { plain: "Services grew.", supported: true, reason: "" },
    ]);
  });

  it("returns nothing for garbage", () => {
    expect(parseSupportVerdicts("I think so", claims)).toEqual([]);
    expect(firstJsonObject('{"a": ')).toBeNull();
  });
});
