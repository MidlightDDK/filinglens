import { describe, expect, it } from "vitest";
import { buildPrompt, PROMPT_VERSION, parseInsufficient } from "./prompt.ts";

const source = (chunk_id: string, text: string) => ({
  chunk_id,
  chunk: {
    text,
    doc_id: "AAPL-FY2025",
    item: "7",
    heading_path: ["Item 7 MD&A", "Net Sales"],
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

describe("buildPrompt", () => {
  it("numbers the sources with company, FY, item, and heading", () => {
    const [system, user] = buildPrompt("  What were net sales?  ", [
      source("a", "Net sales were $416 billion."),
      source("b", " Services grew. "),
    ]);
    expect(system?.role).toBe("system");
    expect(system?.content).toContain(
      "INSUFFICIENT_EVIDENCE: <what is missing>",
    );
    expect(user?.content).toBe(
      "SOURCES:\n\n" +
        "[1] Apple (AAPL) | FY2025 10-K | Item 7 | Item 7 MD&A > Net Sales\nNet sales were $416 billion.\n\n" +
        "[2] Apple (AAPL) | FY2025 10-K | Item 7 | Item 7 MD&A > Net Sales\nServices grew.\n\n" +
        "QUESTION: What were net sales?",
    );
    expect(PROMPT_VERSION).toMatch(/^answer-v\d+$/);
  });
});

describe("parseInsufficient", () => {
  it("extracts what is missing", () => {
    expect(
      parseInsufficient(" INSUFFICIENT_EVIDENCE: Tesla's FY2019 revenue."),
    ).toBe("Tesla's FY2019 revenue.");
    expect(parseInsufficient("**INSUFFICIENT_EVIDENCE**: none")).toBe("none");
  });

  it("returns null for a normal answer", () => {
    expect(parseInsufficient("Net sales were $416 billion [1].")).toBeNull();
  });
});
