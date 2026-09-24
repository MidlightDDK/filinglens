/** A half-open character range [start, end) into some text. */
export interface Span {
  start: number;
  end: number;
}

export interface Citation {
  /** The marker number: `[n]` refers to SOURCES block n. */
  n: number;
  chunk_id: string;
}

/**
 * `[2]`, `[2][5]`, or `[2, 5]`; gpt-oss writes full-width `【2】`, sometimes
 * with a line range (`【2†L4-L9】`), which is ignored.
 */
export const MARKER = /[[【](\d{1,2}(?:\s*,\s*\d{1,2})*)(?:†[^\]】]*)?[\]】]/g;
const MARKERS = String.raw`(?:\s*[\[【]\d{1,2}(?:\s*,\s*\d{1,2})*(?:†[^\]】]*)?[\]】])*`;
/** A sentence end: terminal punctuation, closing quotes, then any markers. */
const END = new RegExp(`[.!?]["'’”)]*(${MARKERS})(?=\\s|$)`, "g");
const LIST_ITEM = /^\s*(?:[-*•]|\d{1,2}[.)])\s+/;
const ABBREVIATIONS = new Set(
  "inc corp co ltd llc no nos vs mr ms mrs dr st jr sr approx fig jan feb mar apr jun jul aug sep sept oct nov dec".split(
    " ",
  ),
);

function trimSpan(text: string, start: number, end: number): Span | null {
  while (start < end && /\s/.test(text[start] ?? "")) start++;
  while (end > start && /\s/.test(text[end - 1] ?? "")) end--;
  return end > start ? { start, end } : null;
}

/** Whether the period at `dot` ends an abbreviation ("U.S.", "Inc.", "e.g.", "F."). */
function isAbbreviation(text: string, lineStart: number, dot: number): boolean {
  const word = /[A-Za-z.]+$/.exec(text.slice(lineStart, dot))?.[0] ?? "";
  return (
    ABBREVIATIONS.has(word.toLowerCase()) ||
    /^(?:[A-Za-z]\.)*[A-Za-z]$/.test(word)
  );
}

/**
 * Splits text into sentence spans. Line breaks always end a sentence, a
 * list-item bullet is not part of its sentence, citation markers after the
 * final period stay with their sentence, and decimals ("$1.2 billion") and
 * uncited abbreviations ("U.S.") don't end one.
 */
export function splitSentences(text: string): Span[] {
  const spans: Span[] = [];
  let lineStart = 0;
  for (const line of text.split("\n")) {
    const lineEnd = lineStart + line.length;
    let start = lineStart + (LIST_ITEM.exec(line)?.[0].length ?? 0);
    for (const m of line.matchAll(END)) {
      const dot = lineStart + m.index;
      const end = dot + m[0].length;
      const next = /\S/.exec(text.slice(end, lineEnd));
      const cited = (m[1] ?? "").trim() !== "";
      if (
        next &&
        !cited &&
        text[dot] === "." &&
        isAbbreviation(text, lineStart, dot)
      ) {
        continue;
      }
      const span = trimSpan(text, start, end);
      if (span) spans.push(span);
      start = end;
    }
    const rest = trimSpan(text, start, lineEnd);
    if (rest) spans.push(rest);
    lineStart = lineEnd + 1;
  }
  return spans;
}

/**
 * Maps the markers in `sentence` to chunk ids (`chunkIds[n - 1]`). Markers
 * outside SOURCES are dropped into `invalid`; `plain` is the sentence without
 * any markers.
 */
export function parseCitations(
  sentence: string,
  chunkIds: readonly string[],
): { plain: string; citations: Citation[]; invalid: number[] } {
  const citations: Citation[] = [];
  const invalid: number[] = [];
  for (const m of sentence.matchAll(MARKER)) {
    for (const part of (m[1] ?? "").split(",")) {
      const n = Number(part.trim());
      const chunk_id = chunkIds[n - 1];
      if (n >= 1 && chunk_id !== undefined) {
        if (!citations.some((c) => c.n === n)) citations.push({ n, chunk_id });
      } else if (!invalid.includes(n)) {
        invalid.push(n);
      }
    }
  }
  const plain = sentence
    .replace(MARKER, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { plain, citations, invalid };
}

/** Text and marker segments, for rendering markers as chips. */
export type Segment =
  | { type: "text"; text: string }
  | { type: "cite"; n: number };

export function segmentMarkers(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(MARKER)) {
    if (m.index > last)
      out.push({ type: "text", text: text.slice(last, m.index) });
    for (const part of (m[1] ?? "").split(",")) {
      out.push({ type: "cite", n: Number(part.trim()) });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}
