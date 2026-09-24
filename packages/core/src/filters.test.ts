import { describe, expect, it } from "vitest";
import { type Docs, detectFilters } from "./filters.ts";

const doc = (
  ticker: string,
  company: string,
  fy: number,
  aliases: string[] = [],
) =>
  [
    `${ticker}-FY${fy}`,
    { company, ticker, aliases, fy, filing_date: "", url: "" },
  ] as const;

const docs: Docs = Object.fromEntries([
  doc("AAPL", "Apple", 2025),
  doc("AAPL", "Apple", 2024),
  doc("NVDA", "NVIDIA", 2026),
  doc("NVDA", "NVIDIA", 2025),
  doc("KO", "Coca-Cola", 2025, ["Coca Cola", "Coke"]),
  doc("KO", "Coca-Cola", 2024, ["Coca Cola", "Coke"]),
  doc("META", "Meta Platforms", 2025, ["Meta", "Facebook"]),
]);

describe("detectFilters", () => {
  it("returns no filter for a generic question", () => {
    const f = detectFilters("How do companies describe AI risk?", docs);
    expect(f.doc_ids).toBeNull();
  });

  it("matches company names, aliases, and possessives case-insensitively", () => {
    expect(detectFilters("apple's iPhone sales", docs).tickers).toEqual([
      "AAPL",
    ]);
    expect(detectFilters("Coke vs Nvidia margins", docs).tickers).toEqual([
      "KO",
      "NVDA",
    ]);
    expect(detectFilters("facebook ad revenue", docs).tickers).toEqual([
      "META",
    ]);
  });

  it("matches tickers only in upper case and only as whole words", () => {
    expect(detectFilters("KO dividends", docs).tickers).toEqual(["KO"]);
    expect(detectFilters("ok, show me kombucha", docs).tickers).toEqual([]);
    expect(detectFilters("metadata handling", docs).tickers).toEqual([]);
  });

  it("parses fiscal years in several forms", () => {
    for (const q of [
      "Apple FY2024",
      "Apple fiscal 2024",
      "Apple FY24",
      "Apple in 2024",
    ]) {
      expect(detectFilters(q, docs).doc_ids).toEqual(["AAPL-FY2024"]);
    }
  });

  it("maps 'last year' to each company's latest filing", () => {
    const f = detectFilters("Apple and NVIDIA revenue last year", docs);
    expect(f.latest).toBe(true);
    expect(f.doc_ids).toEqual(["AAPL-FY2025", "NVDA-FY2026"]);
  });

  it("notes years outside the corpus without filtering them away", () => {
    const f = detectFilters("Apple revenue in 2019", docs);
    expect(f.fiscal_years).toEqual([]);
    expect(f.doc_ids).toEqual(["AAPL-FY2024", "AAPL-FY2025"]);
    expect(f.notes).toEqual(["No filing in the corpus for FY2019"]);
  });

  it("is disabled by passing no docs", () => {
    expect(detectFilters("Apple FY2025", {}).doc_ids).toBeNull();
  });
});
