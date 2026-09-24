import type { Passage } from "../search/protocol";

/**
 * Whether `p` shows the same text as a passage in `others`: the same filing
 * and overlapping characters, so it works across chunking strategies.
 */
export function sharedWith(p: Passage, others: Passage[]): boolean {
  return others.some(
    (o) =>
      o.chunk.doc_id === p.chunk.doc_id &&
      o.chunk.char_start < p.chunk.char_end &&
      p.chunk.char_start < o.chunk.char_end,
  );
}
