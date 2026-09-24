// A small custom BM25 instead of MiniSearch: the serialized index is a compact
// term → postings map we fully control (deterministic output, ~100 lines, no
// dependency), and the same tokenizer runs at build time and at query time.

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by for from had has have in into is it its " +
    "not of on or our such that the their there these they this to was we were " +
    "which will with"
  ).split(" "),
);

/** Plural stripping (a conservative S-stemmer), for alphabetic tokens only. */
function stem(token: string): string {
  if (token.length <= 3 || !/^[a-z]+$/.test(token)) return token;
  if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.endsWith("sses")) return token.slice(0, -2);
  if (/(x|ch|sh)es$/.test(token)) return token.slice(0, -2);
  if (/[^sui]s$/.test(token)) return token.slice(0, -1);
  return token;
}

export function tokenize(text: string): string[] {
  const norm = text.toLowerCase().replace(/(?<=\d),(?=\d{3}(?!\d))/g, "");
  const tokens: string[] = [];
  for (const [raw] of norm.matchAll(/[a-z0-9]+(?:\.[0-9]+)?/g)) {
    if (STOPWORDS.has(raw) || /^[a-z]$/.test(raw)) continue;
    tokens.push(stem(raw));
  }
  return tokens;
}

/** Serialized form (`lexical.json`). Postings are flat [rowDelta, tf, …]. */
export interface LexicalIndexFile {
  version: 1;
  k1: number;
  b: number;
  avgdl: number;
  doc_len: number[];
  postings: Record<string, number[]>;
}

export interface LexicalIndex {
  k1: number;
  b: number;
  avgdl: number;
  docLen: Int32Array;
  postings: Map<string, number[]>;
}

export function buildLexicalIndex(texts: string[]): LexicalIndexFile {
  const postings = new Map<string, number[]>();
  const lastRow = new Map<string, number>();
  const docLen = texts.map((text, row) => {
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [term, n] of tf) {
      const list = postings.get(term) ?? [];
      postings.set(term, list);
      list.push(row - (lastRow.get(term) ?? 0), n);
      lastRow.set(term, row);
    }
    return tokens.length;
  });
  const total = docLen.reduce((a, b) => a + b, 0);
  const sorted = [...postings.keys()].sort();
  return {
    version: 1,
    k1: 1.2,
    b: 0.75,
    avgdl: Math.round((total / Math.max(1, texts.length)) * 1000) / 1000,
    doc_len: docLen,
    postings: Object.fromEntries(sorted.map((t) => [t, postings.get(t) ?? []])),
  };
}

export function loadLexicalIndex(file: LexicalIndexFile): LexicalIndex {
  return {
    k1: file.k1,
    b: file.b,
    avgdl: file.avgdl,
    docLen: Int32Array.from(file.doc_len),
    postings: new Map(Object.entries(file.postings)),
  };
}

export interface Hit {
  row: number;
  score: number;
}

/** Sorts hits by score (desc), then row (asc) so ties are deterministic. */
export function topHits(hits: Hit[], k: number): Hit[] {
  return hits
    .sort((x, y) => y.score - x.score || x.row - y.row)
    .slice(0, Math.max(0, k));
}

export function searchLexical(
  index: LexicalIndex,
  query: string,
  allowed: Uint8Array | null,
  k: number,
): Hit[] {
  const { k1, b, avgdl, docLen, postings } = index;
  const n = docLen.length;
  const scores = new Float64Array(n);
  const touched: number[] = [];
  for (const term of new Set(tokenize(query))) {
    const list = postings.get(term);
    if (!list) continue;
    const df = list.length / 2;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    let row = 0;
    for (let i = 0; i < list.length; i += 2) {
      row += list[i] ?? 0;
      if (allowed && !allowed[row]) continue;
      const tf = list[i + 1] ?? 0;
      const norm = k1 * (1 - b + (b * (docLen[row] ?? 0)) / avgdl);
      if (scores[row] === 0) touched.push(row);
      scores[row] = (scores[row] ?? 0) + (idf * tf * (k1 + 1)) / (tf + norm);
    }
  }
  return topHits(
    touched.map((row) => ({ row, score: scores[row] ?? 0 })),
    k,
  );
}
