import { describe, expect, it } from "vitest";
import { quantize, searchDense } from "./dense.ts";

const normalize = (v: number[]) => {
  const n = Math.hypot(...v);
  return Float32Array.from(v, (x) => x / n);
};

describe("int8 dense search", () => {
  const vectors = [
    [1, 0, 0, 0],
    [0.7, 0.7, 0, 0],
    [0, 0, 1, 0],
    [0, 0.2, 0.2, 0.9],
  ].map((v) => Float32Array.from(v));
  const { values, scales } = quantize(vectors, 4);

  it("L2-normalizes before quantizing, so scores approximate cosine", () => {
    const q = normalize([1, 1, 0, 0]);
    const hits = searchDense(values, scales, 4, q, null, 4);
    expect(hits.map((h) => h.row)).toEqual([1, 0, 3, 2]);
    expect(hits[0]?.score).toBeCloseTo(1, 2);
    expect(hits[1]?.score).toBeCloseTo(Math.SQRT1_2, 2);
  });

  it("uses the full int8 range per row", () => {
    expect(Math.max(...values.slice(0, 4))).toBe(127);
  });

  it("skips rows outside the allowed mask", () => {
    const q = normalize([1, 1, 0, 0]);
    const allowed = Uint8Array.from([1, 0, 1, 0]);
    expect(
      searchDense(values, scales, 4, q, allowed, 4).map((h) => h.row),
    ).toEqual([0, 2]);
  });
});
