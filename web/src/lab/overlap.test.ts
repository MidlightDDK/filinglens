import { describe, expect, it } from "vitest";
import type { Passage } from "../search/protocol";
import { sharedWith } from "./overlap";

const passage = (doc_id: string, char_start: number, char_end: number) =>
  ({ chunk: { doc_id, char_start, char_end } }) as Passage;

describe("sharedWith", () => {
  const others = [passage("AAPL-2025", 100, 200)];

  it("matches overlapping text in the same filing, across chunkings", () => {
    expect(sharedWith(passage("AAPL-2025", 150, 400), others)).toBe(true);
    expect(sharedWith(passage("AAPL-2025", 0, 101), others)).toBe(true);
  });

  it("rejects adjacent ranges and other filings", () => {
    expect(sharedWith(passage("AAPL-2025", 200, 300), others)).toBe(false);
    expect(sharedWith(passage("AAPL-2024", 100, 200), others)).toBe(false);
  });
});
