import {
  type Citation,
  parseCitations,
  type Span,
  splitSentences,
} from "./citations.ts";

/** A number written in text, normalized. */
export interface NumberMention {
  /** As written, e.g. "$1.2 billion", "(1,234)", "45.3%". */
  raw: string;
  start: number;
  end: number;
  /** Signed, scale applied: "$1.2 billion" → 1.2e9, "(5)" → -5. */
  value: number;
  /** Half a unit of the last written digit, scaled: "$1.2 billion" → 5e7. */
  tolerance: number;
  percent: boolean;
  currency: boolean;
  /** A scale word ("million", "bn", "M") was written, so `value` is absolute. */
  scaled: boolean;
  perShare: boolean;
}

const SCALES: Record<string, number> = {
  thousand: 1e3,
  k: 1e3,
  million: 1e6,
  mn: 1e6,
  mm: 1e6,
  m: 1e6,
  billion: 1e9,
  bn: 1e9,
  b: 1e9,
  trillion: 1e12,
};

// (paren)(sign)($)digits(decimals) then a percent, a scale word, or a scale
// letter glued to the number ("$1.2B"), then an optional closing paren.
const NUMBER =
  /(\()?(?:(?<!\w)([-−]))?(?:(\$)\s*)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s?(%|percent(?:age points?)?\b|points?\b)|\s?(trillion|billion|million|thousand|bn|mn|mm)\b|([BMK])\b)?(\))?/gi;
const REFERENCE =
  /\b(?:items?|notes?|parts?|sections?|rules?|forms?|schedules?|exhibits?|articles?|regulations?|levels?|tiers?|chapters?|phases?)\s*$/i;
const MONTH =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s*$/i;
const PER_SHARE =
  /^\s*(?:per|a)\s+(?:diluted\s+|basic\s+)?(?:common\s+)?share/i;
const isWordChar = (c: string | undefined) => c !== undefined && /\w/.test(c);
/** Hyphens and dashes models write ("10‑K" with U+2011, "10–15"). */
const DASHES = "-‐‑‒–—";

/**
 * Numbers in `text`: commas, %, $, million/billion/thousand (and "bn", "$5M"),
 * parentheses as negatives, per-share values. Skips years, days in dates,
 * references ("Item 7", "Note 12", "10-K"), and digits inside words ("H100",
 * "FY2025", "COVID-19").
 */
export function extractNumbers(text: string): NumberMention[] {
  const out: NumberMention[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const [raw, open, sign, dollar, int = "", frac, pct, word, letter, close] =
      m;
    const start = m.index;
    let end = start + raw.length;
    const before = text[start - 1];
    // Digits glued to a word or to "word-" / "word/" ("FY2025", "COVID-19",
    // "10b5-1"); the end of a range ("10–15") is fine.
    if (isWordChar(before) || before === ".") continue;
    if (
      (DASHES.includes(before ?? "x") || before === "/") &&
      /\w$/.test(text.slice(0, start - 1)) &&
      !/(?:^|[^\w.,])\d[\d,.]*$/.test(text.slice(0, start - 1))
    ) {
      continue;
    }
    const after = text.slice(end);
    if (/^[A-Za-z]/.test(after)) continue;
    if (DASHES.includes(after[0] ?? "x") && /^.[A-Z](?![a-z])/.test(after)) {
      continue; // "10-K", "8-K"
    }
    const prefix = text.slice(Math.max(0, start - 20), start);
    if (REFERENCE.test(prefix) || MONTH.test(prefix)) continue;

    // "(5)%": a negative percent in a table.
    const trailingPct = close !== undefined && !pct && text[end] === "%";
    if (trailingPct) end += 1;
    const percent = pct !== undefined || trailingPct;
    const scaleWord = (word ?? letter)?.toLowerCase();
    const scale = scaleWord ? (SCALES[scaleWord] ?? 1) : 1;
    const plain = !dollar && !percent && !scaleWord && !frac;
    const intValue = Number(int.replace(/,/g, ""));
    if (plain && !int.includes(",") && intValue >= 1900 && intValue <= 2100) {
      continue; // a year
    }
    // A lone "(" or ")" belongs to the surrounding prose, not the number.
    const negativeParen = open !== undefined && close !== undefined;
    let body = trailingPct ? `${raw}%` : raw;
    if (open && !close) body = body.slice(1);
    if (close && !open) {
      body = body.slice(0, -1);
      end -= 1;
    }
    const decimals = frac ? frac.length - 1 : 0;
    const magnitude = (intValue + (frac ? Number(`0${frac}`) : 0)) * scale;
    const negative = negativeParen || sign !== undefined;
    out.push({
      raw: body.trim(),
      start: open && !close ? start + 1 : start,
      end,
      value: negative ? -magnitude : magnitude,
      tolerance: 0.5 * 10 ** -decimals * scale,
      percent,
      currency: dollar !== undefined,
      scaled: scaleWord !== undefined,
      perShare: PER_SHARE.test(text.slice(end)),
    });
  }
  return out;
}

/**
 * Whether `source` (a number in a cited passage) backs `claim` (a number in
 * the answer), allowing the claim's own rounding ("$193.7 billion" for
 * "193,737" in a table in millions). Signs are ignored: prose says "a loss of
 * $5 million" where a table says "(5)". Unscaled source numbers may be in
 * thousands, millions, or billions, as table headers say.
 */
export function numbersMatch(
  claim: NumberMention,
  source: NumberMention,
): boolean {
  const target = Math.abs(claim.value);
  const v = Math.abs(source.value);
  // Table cells like "$416,161%" (a dollar amount glued to the next column's
  // "%") count as dollar amounts.
  const sourcePercent = source.percent && !source.currency;
  let candidates: number[];
  if (claim.percent) {
    if (!sourcePercent && (source.scaled || source.currency)) return false;
    candidates = [v];
  } else {
    if (sourcePercent) return false;
    candidates = source.scaled ? [v] : [v, v * 1e3, v * 1e6, v * 1e9];
  }
  const slack = claim.tolerance + target * 1e-9;
  return candidates.some((c) => Math.abs(c - target) <= slack);
}

export type SentenceStatus = "verified" | "unverified" | "unsupported";

export interface SentenceCheck {
  /** The sentence as written, with its markers. */
  text: string;
  /** Without markers. */
  plain: string;
  citations: Citation[];
  /** Markers pointing outside SOURCES (dropped). */
  invalid: number[];
  /** Numbers that were checked, as written. */
  numbers: string[];
  /**
   * Numbers not in a cited passage but one arithmetic step from two numbers
   * of the same answer that are (see `verifySentences`).
   */
  derived: string[];
  /** Numbers neither found nor derived. */
  missing: string[];
  /**
   * `verified`: at least one valid citation, and every number is found or
   * derived. `unverified` otherwise. Only the judge makes a sentence
   * `unsupported` (see `withJudge`).
   */
  status: Exclude<SentenceStatus, "unsupported">;
  reason: "ok" | "no_citation" | "number_not_found";
}

/** Chunk id → passage text (undefined when unavailable). */
export type ChunkText = (chunkId: string) => string | undefined;

/**
 * Results of one arithmetic step on two numbers: difference and sum of like
 * amounts, ratios, and for percent claims, percentage-point differences,
 * shares, and percent changes.
 */
function oneStep(
  a: NumberMention,
  b: NumberMention,
  percent: boolean,
): number[] {
  const x = Math.abs(a.value);
  const y = Math.abs(b.value);
  if (x === 0 || y === 0 || x === y) return [];
  const hi = Math.max(x, y);
  const lo = Math.min(x, y);
  if (a.percent !== b.percent) return [];
  if (a.percent) return percent ? [hi - lo] : [];
  return percent
    ? [
        (lo / hi) * 100,
        (hi / lo) * 100,
        ((hi - lo) / lo) * 100,
        ((hi - lo) / hi) * 100,
      ]
    : [hi - lo, hi + lo, hi / lo, lo / hi];
}

function derivable(claim: NumberMention, operands: NumberMention[]): boolean {
  const target = Math.abs(claim.value);
  const slack = claim.tolerance + target * 1e-9;
  for (const [i, a] of operands.entries()) {
    for (const b of operands.slice(i + 1)) {
      if (
        oneStep(a, b, claim.percent).some((v) => Math.abs(v - target) <= slack)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The deterministic check of an answer's sentences against their cited
 * passages. A number is found when it appears in a passage its sentence
 * cites, and derived when it is one arithmetic step from two found numbers
 * of the same answer ("$7.46 vs $7.17 [1]. Apple's was $0.29 higher [1].").
 * Operands must be written in the answer, so a stray number can't be matched
 * against the many combinations of a passage's table cells.
 */
export function verifySentences(
  sentences: readonly string[],
  chunkIds: readonly string[],
  chunkText: ChunkText,
): SentenceCheck[] {
  const parsed = sentences.map((sentence) => {
    const { plain, citations, invalid } = parseCitations(sentence, chunkIds);
    const claimed = extractNumbers(plain);
    const pool = citations.flatMap((c) =>
      extractNumbers(chunkText(c.chunk_id) ?? ""),
    );
    const found = claimed.map((n) => pool.some((p) => numbersMatch(n, p)));
    return { sentence, plain, citations, invalid, claimed, found };
  });
  const operands = parsed.flatMap((p) =>
    p.claimed.filter((_, i) => p.found[i]),
  );
  return parsed.map((p) => {
    const derived: string[] = [];
    const missing: string[] = [];
    p.claimed.forEach((n, i) => {
      if (!p.found[i]) (derivable(n, operands) ? derived : missing).push(n.raw);
    });
    const reason =
      p.citations.length === 0
        ? "no_citation"
        : missing.length > 0
          ? "number_not_found"
          : "ok";
    return {
      text: p.sentence,
      plain: p.plain,
      citations: p.citations,
      invalid: p.invalid,
      numbers: p.claimed.map((n) => n.raw),
      derived,
      missing,
      status: reason === "ok" ? "verified" : "unverified",
      reason,
    };
  });
}

/** One sentence on its own (no other sentences to derive numbers from). */
export function verifySentence(
  sentence: string,
  chunkIds: readonly string[],
  chunkText: ChunkText,
): SentenceCheck {
  return verifySentences([sentence], chunkIds, chunkText)[0] as SentenceCheck;
}

/** The answer's sentences as the UI renders them (emphasis and heading marks dropped). */
export function answerSentences(answer: string): string[] {
  const text = answer.replace(/\*\*|__/g, "").replace(/^#+\s+/gm, "");
  return splitSentences(text).map((s) => text.slice(s.start, s.end));
}

export function verifyAnswer(
  answer: string,
  chunkIds: readonly string[],
  chunkText: ChunkText,
): SentenceCheck[] {
  return verifySentences(answerSentences(answer), chunkIds, chunkText);
}

/** The final status once the judge ruled: `supported === false` wins. */
export function withJudge(
  check: Pick<SentenceCheck, "status">,
  supported: boolean | undefined,
): SentenceStatus {
  return supported === false ? "unsupported" : check.status;
}

const STOPWORDS = new Set(
  "a an and are as at be by for from has have in is it its of on or that the this to was were which with".split(
    " ",
  ),
);

/** Lowercased content words (numbers are matched by value instead). */
function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]+/g) ?? []).filter(
    (t) => !STOPWORDS.has(t),
  );
}

/**
 * The part of `chunkText` that best supports `sentence`: the chunk sentence
 * (or line) with the most of its numbers (by value, so "$193.7 billion"
 * finds "193,737"), then the most shared words. Null when nothing overlaps.
 */
export function highlightSpan(
  sentence: string,
  chunkText: string,
): Span | null {
  const plain = parseCitations(sentence, []).plain;
  const wanted = new Set(words(plain));
  const claimed = extractNumbers(plain);
  if (wanted.size === 0 && claimed.length === 0) return null;
  let best: Span | null = null;
  let bestScore = 0;
  for (const span of splitSentences(chunkText)) {
    const text = chunkText.slice(span.start, span.end);
    const numbers = extractNumbers(text);
    let score =
      100 *
      claimed.filter((n) => numbers.some((p) => numbersMatch(n, p))).length;
    for (const t of new Set(words(text))) if (wanted.has(t)) score += 1;
    if (score > bestScore) {
      best = span;
      bestScore = score;
    }
  }
  return best;
}
