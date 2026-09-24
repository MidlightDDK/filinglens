import { describe, expect, it } from "vitest";
import { cacheKey, TokenBucket } from "./llm.ts";

describe("TokenBucket", () => {
  it("allows a burst, then paces to the per-minute rate", () => {
    let now = 0;
    const bucket = new TokenBucket(60, () => now);
    for (let i = 0; i < 60; i++) expect(bucket.reserve(1)).toBe(0);
    expect(bucket.reserve(1)).toBe(1000);
    now = 10_000;
    expect(bucket.reserve(5)).toBe(0);
  });
});

describe("cacheKey", () => {
  it("changes with the model or the prompt", () => {
    const req = {
      model: "m",
      messages: [{ role: "user" as const, content: "hi" }],
    };
    expect(cacheKey(req)).toBe(cacheKey({ ...req }));
    expect(cacheKey(req)).not.toBe(cacheKey({ ...req, model: "n" }));
  });
});
