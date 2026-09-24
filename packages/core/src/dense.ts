import { type Hit, topHits } from "./lexical.ts";

/** L2-normalizes each vector, then quantizes it to int8 with a per-row scale. */
export function quantize(
  vectors: Float32Array[],
  dim: number,
): { values: Int8Array; scales: Float32Array } {
  const values = new Int8Array(vectors.length * dim);
  const scales = new Float32Array(vectors.length);
  vectors.forEach((v, row) => {
    let norm = 0;
    for (let j = 0; j < dim; j++) norm += (v[j] ?? 0) ** 2;
    norm = Math.sqrt(norm) || 1;
    let max = 0;
    for (let j = 0; j < dim; j++)
      max = Math.max(max, Math.abs((v[j] ?? 0) / norm));
    const scale = max / 127 || 1;
    scales[row] = scale;
    for (let j = 0; j < dim; j++) {
      values[row * dim + j] = Math.round((v[j] ?? 0) / norm / scale);
    }
  });
  return { values, scales };
}

/** Brute-force cosine similarity of a normalized query against int8 rows. */
export function searchDense(
  values: Int8Array,
  scales: Float32Array,
  dim: number,
  query: Float32Array,
  allowed: Uint8Array | null,
  k: number,
): Hit[] {
  const hits: Hit[] = [];
  for (let row = 0; row < scales.length; row++) {
    if (allowed && !allowed[row]) continue;
    const off = row * dim;
    let dot = 0;
    for (let j = 0; j < dim; j++)
      dot += (query[j] ?? 0) * (values[off + j] ?? 0);
    hits.push({ row, score: dot * (scales[row] ?? 0) });
  }
  return topHits(hits, k);
}
