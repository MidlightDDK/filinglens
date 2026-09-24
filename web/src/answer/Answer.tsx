import {
  INSUFFICIENT,
  parseCitations,
  parseInsufficient,
  type SentenceCheck,
  type SentenceStatus,
  type SupportVerdict,
  segmentMarkers,
  verifySentences,
  withJudge,
} from "@filinglens/core";
import type { Passage } from "../search/protocol";
import { answerBlocks } from "./render";
import type { AnswerState } from "./useAnswer";
import type { JudgeState } from "./useVerify";

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

const JUDGE_MESSAGES: Record<string, string> = {
  quota: "The AI judge has used up today's free quota. Try again tomorrow.",
  rate_limit: "Too many requests this minute. Wait a minute and try again.",
};

export const sourceTitle = ({ doc, chunk }: Passage) =>
  `${doc.company} FY${doc.fy}, Item ${chunk.item}`;

/** A sentence's final status and why, for its badge. */
interface Status {
  status: SentenceStatus;
  detail: string;
}

const BADGES: Record<
  SentenceStatus,
  { icon: string; label: string; className: string }
> = {
  verified: {
    icon: "✓",
    label: "Verified",
    className: "border-emerald-200 bg-emerald-50 text-emerald-800",
  },
  unverified: {
    icon: "?",
    label: "Unverified",
    className: "border-amber-300 bg-amber-50 text-amber-900",
  },
  unsupported: {
    icon: "✗",
    label: "Unsupported",
    className: "border-red-200 bg-red-50 text-red-800",
  },
};

function StatusBadge({ status, detail }: Status) {
  const badge = BADGES[status];
  return (
    <span
      data-status={status}
      title={detail}
      className={`ml-1 inline-flex items-center gap-0.5 rounded border px-1 align-text-top text-[11px] font-medium leading-4 ${badge.className}`}
    >
      <span aria-hidden="true">{badge.icon}</span>
      {badge.label}
      <span className="sr-only">: {detail}</span>
    </span>
  );
}

/** The deterministic check, overruled by the judge's "not supported". */
function statusOf(
  check: SentenceCheck,
  verdicts: ReadonlyMap<string, SupportVerdict>,
): Status {
  const verdict = verdicts.get(check.plain);
  const status = withJudge(check, verdict?.supported);
  if (status === "unsupported") {
    return {
      status,
      detail: `AI judge: ${verdict?.reason || "the cited text doesn't support this"}`,
    };
  }
  if (check.reason === "no_citation") return { status, detail: "No citation" };
  if (check.reason === "number_not_found") {
    return {
      status,
      detail: `Not in the cited passage: ${check.missing.join(", ")}`,
    };
  }
  return {
    status,
    detail: `Cited, and every number ${
      check.derived.length
        ? `appears in the cited passage or is computed from ones that do (${check.derived.join(", ")})`
        : "appears in the cited passage"
    }${verdict?.supported ? "; the AI judge agrees" : ""}`,
  };
}

function Checks({
  statuses,
  judge,
  onJudge,
}: {
  statuses: Status[];
  judge: JudgeState;
  onJudge?: () => void;
}) {
  const count = (s: SentenceStatus) =>
    statuses.filter((x) => x.status === s).length;
  const unsupported = count("unsupported");
  let message =
    "An independent model checks each cited sentence against its passage.";
  if (judge.status === "pending") message = "Checking…";
  if (judge.status === "error") {
    message =
      JUDGE_MESSAGES[judge.reason] ?? "The AI judge is unavailable right now.";
  }
  if (judge.status === "done") {
    const { verdicts, model, cached } = judge.result;
    const ok = verdicts.filter((v) => v.supported).length;
    message = verdicts.length
      ? `Judged by ${model}${cached ? " (cached)" : ""}: ${ok} of ${verdicts.length} cited sentences supported.`
      : "No cited sentences to judge.";
  }
  return (
    <div
      data-testid="checks"
      className="mt-3 border-t border-slate-100 pt-3 text-sm text-slate-600"
    >
      <p>
        <span className="font-medium text-slate-800">Checks:</span>{" "}
        {count("verified")} verified · {count("unverified")} unverified
        {unsupported ? ` · ${unsupported} unsupported` : ""}. Verified means the
        sentence cites a passage and every number in it appears there.
      </p>
      {onJudge && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            onClick={onJudge}
            disabled={judge.status === "pending" || judge.status === "done"}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-60"
          >
            {judge.status === "pending"
              ? "Judging…"
              : judge.status === "done"
                ? "Checked by AI judge"
                : "Check with AI judge"}
          </button>
          <span role="status" data-testid="judge-status">
            {message}
          </span>
        </div>
      )}
    </div>
  );
}

function Sentence({
  text,
  sources,
  active,
  onCite,
  status,
}: {
  text: string;
  sources: Passage[];
  active: ActiveCite | null;
  onCite: (cite: ActiveCite) => void;
  /** Shown once the answer is complete. */
  status?: Status;
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
      })}
      {status && <StatusBadge {...status} />}{" "}
    </span>
  );
}

export function Answer({
  state,
  sources,
  active,
  onCite,
  checkNeeded = false,
  judge = { status: "idle" },
  onJudge,
}: {
  state: AnswerState;
  sources: Passage[];
  active: ActiveCite | null;
  onCite: (cite: ActiveCite) => void;
  /** Turnstile wants the visitor to complete its check first. */
  checkNeeded?: boolean;
  judge?: JudgeState;
  onJudge?: () => void;
}) {
  if (state.status === "idle") return null;
  const { text, status } = state;
  const trimmed = text.trim();
  const missing = parseInsufficient(text);
  const writing =
    status === "pending" ||
    (status === "streaming" && INSUFFICIENT.startsWith(trimmed));
  const blocks = answerBlocks(text);
  const current: JudgeState =
    judge.status !== "idle" && judge.answer === text
      ? judge
      : { status: "idle" };
  const verdicts = new Map(
    current.status === "done"
      ? current.result.verdicts.map((v) => [v.plain, v])
      : [],
  );
  // Statuses need complete sentences, so they appear once the answer is done.
  let statuses: Status[][] | null = null;
  if (status === "done") {
    const checks = verifySentences(
      blocks.flatMap((b) => b.sentences),
      sources.map((s) => s.candidate.chunk_id),
      (id) => sources.find((s) => s.candidate.chunk_id === id)?.chunk.text,
    ).map((c) => statusOf(c, verdicts));
    let k = 0;
    statuses = blocks.map((b) => b.sentences.map(() => checks[k++] as Status));
  }

  return (
    <section
      aria-label="Answer"
      aria-busy={status === "pending" || status === "streaming"}
      className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
    >
      <h2 className="text-sm font-medium text-slate-500">Answer</h2>
      {writing && (
        <p className="mt-2 text-slate-500" role="status">
          {status === "pending" && checkNeeded
            ? "Complete the Cloudflare check above to get a live answer."
            : "Writing a cited answer…"}
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
          {blocks.map((block, b) => {
            const sentences = block.sentences.map((s, i) => (
              <Sentence
                /*  biome-ignore lint/suspicious/noArrayIndexKey: positional parts of the answer text, which only grows */
                key={i}
                text={s}
                sources={sources}
                active={active}
                onCite={onCite}
                status={statuses?.[b]?.[i]}
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

      {missing === null && statuses && statuses.flat().length > 0 && (
        <Checks statuses={statuses.flat()} judge={current} onJudge={onJudge} />
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
