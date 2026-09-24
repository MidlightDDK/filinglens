// The support judge: does a sentence's cited text back it? Shared by the
// Worker (`/api/verify`) and the eval runners, which calibrate it against
// human labels (evals/datasets/judge_labels.jsonl).
import { parseCitations } from "./citations.ts";
import { type ChatMessage, type PromptSource, sourceLabel } from "./prompt.ts";
import { answerSentences } from "./verify.ts";

/** Bump on any change to the judge prompt; caches and reports include it. */
export const JUDGE_VERSION = "support-v1";

/** A cited sentence to judge; `cites` are its valid `[n]` markers. */
export interface Claim {
  plain: string;
  cites: number[];
}

export interface SupportVerdict {
  /** The sentence without markers (`Claim.plain`). */
  plain: string;
  supported: boolean;
  reason: string;
}

const SYSTEM = `You check whether cited sources support the claims in an answer about SEC 10-K filings.

For each numbered CLAIM, read only the sources it cites and decide:
- supported: true if everything the claim states (numbers, companies, fiscal years, segments, direction of change) is stated in its cited sources or follows from them by simple arithmetic (sums, differences, ratios, percentage changes) or rounding. A claim that the sources do not disclose something counts as supported when the cited sources indeed do not state it.
- supported: false if any part is missing from its cited sources or contradicts them, including numbers that differ beyond rounding, a wrong fiscal year, or a wrong company or segment.

Reply with JSON only, one verdict per claim, in order:
{"verdicts":[{"claim":1,"supported":true,"reason":"<at most 12 words>"}]}`;

/** The answer's sentences with at least one valid citation, in order. */
export function claimsOf(answer: string, chunkIds: readonly string[]): Claim[] {
  const claims: Claim[] = [];
  for (const sentence of answerSentences(answer)) {
    const { plain, citations } = parseCitations(sentence, chunkIds);
    if (citations.length > 0) {
      claims.push({ plain, cites: citations.map((c) => c.n) });
    }
  }
  return claims;
}

/**
 * Judge messages for `claims`. `sources[n - 1]` is the source `[n]` refers
 * to; only cited sources are included.
 */
export function buildSupportPrompt(
  question: string,
  claims: Claim[],
  sources: readonly PromptSource[],
): ChatMessage[] {
  const cited = [...new Set(claims.flatMap((c) => c.cites))].sort(
    (a, b) => a - b,
  );
  const blocks = cited
    .map((n) => {
      const s = sources[n - 1];
      return s ? `[${n}] ${sourceLabel(s)}\n${s.chunk.text.trim()}` : null;
    })
    .filter((b) => b !== null)
    .join("\n\n");
  const list = claims
    .map(
      (c, i) =>
        `CLAIM ${i + 1} (cites ${c.cites.map((n) => `[${n}]`).join("")}): ${c.plain}`,
    )
    .join("\n");
  return [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `SOURCES:\n\n${blocks}\n\nQUESTION: ${question.trim()}\n\nCLAIMS:\n${list}`,
    },
  ];
}

/** The first balanced JSON object in `text` (models sometimes add prose or fences). */
export function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Verdicts from the judge's reply, in claim order. Claims the reply skips or
 * garbles get no verdict (the deterministic status stands).
 */
export function parseSupportVerdicts(
  text: string,
  claims: readonly Claim[],
): SupportVerdict[] {
  const parsed = firstJsonObject(text) as {
    verdicts?: { claim?: unknown; supported?: unknown; reason?: unknown }[];
  } | null;
  const out: SupportVerdict[] = [];
  for (const v of parsed?.verdicts ?? []) {
    const claim = claims[Number(v.claim) - 1];
    if (!claim || typeof v.supported !== "boolean") continue;
    if (out.some((o) => o.plain === claim.plain)) continue;
    out.push({
      plain: claim.plain,
      supported: v.supported,
      reason: typeof v.reason === "string" ? v.reason.slice(0, 200) : "",
    });
  }
  return out;
}
