import type { ExampleFile } from "@filinglens/core";
import { EXAMPLES } from "./examples";

const cache = new Map<string, Promise<ExampleFile>>();

/** A precomputed example (static file, no API call), fetched once. */
export function loadExample(id: string): Promise<ExampleFile> {
  let p = cache.get(id);
  if (!p) {
    p = fetch(`/examples/${id}.json`).then((res) => {
      if (!res.ok) throw new Error(`/examples/${id}.json: HTTP ${res.status}`);
      return res.json() as Promise<ExampleFile>;
    });
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}

/** Warms the cache (~40 KB gzipped in total) so chips render instantly. */
export function prefetchExamples() {
  for (const ex of EXAMPLES) loadExample(ex.id).catch(() => {});
}
