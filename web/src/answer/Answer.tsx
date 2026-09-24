import {
  INSUFFICIENT,
  parseCitations,
  parseInsufficient,
  segmentMarkers,
} from "@filinglens/core";
import type { Passage } from "../search/protocol";
import { answerBlocks } from "./render";
import type { AnswerState } from "./useAnswer";

/** The citation the visitor clicked: source `n`, cited by `sentence`. */
export interface ActiveCite {
  n: number;
  sentence: string;
}

const MESSAGES: Record<string, string> = {
  quota:
    "Live answers have used up today's free AI quota. Quotas reset daily; the passages below still come from live retrieval in your browser.",
  rate_limit:
    "That's more questions per minute than the free tier allows. Please wait a minute and ask again.",
  turnstile:
    "We couldn't confirm this is a real browser (Cloudflare Turnstile). Reload the page and try again.",
  session: "Your session expired. Ask again to start a new one.",
  provider:
    "The AI provider stopped in the middle of the answer. Ask again to retry.",
};
const FALLBACK =
  "Live answers are unavailable right now. The passages below still come from live retrieval in your browser.";

export const sourceTitle = ({ doc, chunk }: Passage) =>
  `${doc.company} FY${doc.fy}, Item ${chunk.item}`;

function Sentence({
  text,
  sources,
  active,
  onCite,
}: {
  text: string;
  sources: Passage[];
  active: ActiveCite | null;
  onCite: (cite: ActiveCite) => void;
}) {
  const { plain } = parseCitations(
    text,
    sources.map((s) => s.candidate.chunk_id),
  );
  const segments = segmentMarkers(text);
  return (
    <span data-sentence>
      {segments.map((seg, i) => {
        if (seg.type === "text") {
          // "10% [2]." renders as "10% ²." without a space before the period.
          const afterCite = segments[i - 1]?.type === "cite";
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional parts of the answer text, which only grows
            <span key={i}>
              {afterCite ? seg.text.replace(/^\s+(?=[.,;:!?])/, "") : seg.text}
            </span>
          );
        }
        const source = sources[seg.n - 1];
        if (!source) return null; // markers outside SOURCES are dropped
        const pressed = active?.n === seg.n && active.sentence === plain;
        return (
          <button
            /*  biome-ignore lint/suspicious/noArrayIndexKey: positional parts of the answer text, which only grows */
            key={i}
            type="button"
            aria-pressed={pressed}
            aria-label={`Source ${seg.n}: ${sourceTitle(source)}`}
            title={sourceTitle(source)}
            onClick={() => onCite({ n: seg.n, sentence: plain })}
            className={`mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded px-1 align-text-top text-xs font-semibold ${
              pressed
                ? "bg-blue-700 text-white"
                : "bg-blue-100 text-blue-800 hover:bg-blue-200"
            }`}
          >
            {seg.n}
          </button>
        );
      })}{" "}
    </span>
  );
}

export function Answer({
  state,
  sources,
  active,
  onCite,
}: {
  state: AnswerState;
  sources: Passage[];
  active: ActiveCite | null;
  onCite: (cite: ActiveCite) => void;
}) {
  if (state.status === "idle") return null;
  const { text, status } = state;
  const trimmed = text.trim();
  const missing = parseInsufficient(text);
  const writing =
    status === "pending" ||
    (status === "streaming" && INSUFFICIENT.startsWith(trimmed));

  return (
    <section
      aria-label="Answer"
      aria-busy={status === "pending" || status === "streaming"}
      className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
    >
      <h2 className="text-sm font-medium text-slate-500">Answer</h2>
      {writing && (
        <p className="mt-2 text-slate-500" role="status">
          Writing a cited answer…
        </p>
      )}

      {missing !== null && !writing && (
        <div data-testid="insufficient" className="mt-2">
          <p className="font-medium">The filings don't answer this.</p>
          <p className="mt-1 text-slate-700">
            {missing || "The retrieved passages don't contain the answer."}
          </p>
          <p className="mt-2 text-sm text-slate-500">
            FilingLens only answers from the 10-K filings it indexes, and says
            so instead of guessing. The closest passages are below.
          </p>
        </div>
      )}

      {missing === null && !writing && trimmed && (
        <div
          data-testid="answer-text"
          className="mt-2 flex flex-col gap-2 leading-relaxed"
        >
          {answerBlocks(text).map((block, b) => {
            const sentences = block.sentences.map((s, i) => (
              <Sentence
                /*  biome-ignore lint/suspicious/noArrayIndexKey: positional parts of the answer text, which only grows */
                key={i}
                text={s}
                sources={sources}
                active={active}
                onCite={onCite}
              />
            ));
            return (
              <p
                /*  biome-ignore lint/suspicious/noArrayIndexKey: positional parts of the answer text, which only grows */
                key={b}
                className={block.kind === "li" ? "pl-4 -indent-4" : undefined}
              >
                {block.kind === "li" && "• "}
                {sentences}
              </p>
            );
          })}
        </div>
      )}

      {status === "error" && (
        <p
          role="status"
          data-testid="answer-error"
          className="mt-2 text-slate-700"
        >
          {MESSAGES[state.reason ?? ""] ?? FALLBACK}
        </p>
      )}

      {status === "done" && state.done && (
        <p className="mt-3 text-xs text-slate-500" data-testid="answer-meta">
          {state.done.model} via {state.done.provider} ·{" "}
          {(state.done.latencyMs / 1000).toFixed(1)} s
          {state.done.usage
            ? ` · ${state.done.usage.prompt_tokens + state.done.usage.completion_tokens} tokens`
            : ""}
          {state.done.cached ? " · cached" : ""}
        </p>
      )}
    </section>
  );
}
