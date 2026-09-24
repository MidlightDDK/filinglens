import { highlightSpan, type Ranked } from "@filinglens/core";
import { useEffect, useRef } from "react";
import type { ActiveCite } from "../answer/Answer";
import type { Passage } from "../search/protocol";

const rank = (label: string, r: Ranked | null) =>
  r ? `${label} #${r.rank}` : `${label}: not in top 50`;

export function PassageText({
  text,
  sentence,
}: {
  text: string;
  sentence?: string;
}) {
  const mark = useRef<HTMLElement>(null);
  const span = sentence ? highlightSpan(sentence, text) : null;
  const start = span?.start;
  useEffect(() => {
    if (start !== undefined) {
      mark.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [start]);
  if (!span) return <>{text}</>;
  return (
    <>
      {text.slice(0, span.start)}
      <mark
        ref={mark}
        data-testid="highlight"
        className="rounded bg-yellow-200 px-0.5"
      >
        {text.slice(span.start, span.end)}
      </mark>
      {text.slice(span.end)}
    </>
  );
}

/** The sources sent to the model, numbered as the answer's markers are. */
export function Passages({
  passages,
  active = null,
}: {
  passages: Passage[];
  active?: ActiveCite | null;
}) {
  if (passages.length === 0) {
    return <p className="text-slate-600">No matching passages.</p>;
  }
  return (
    <ol className="flex flex-col gap-4">
      {passages.map(({ candidate, chunk, doc }, i) => {
        const isActive = active?.n === i + 1;
        return (
          <li
            key={candidate.chunk_id}
            id={`source-${i + 1}`}
            data-chunk-id={candidate.chunk_id}
            data-active={isActive || undefined}
            className={`rounded-lg border bg-white p-4 shadow-sm ${
              isActive
                ? "border-blue-600 ring-2 ring-blue-200"
                : "border-slate-200"
            }`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h3 className="font-medium">
                <span className="text-slate-400">[{i + 1}]</span> {doc.company}{" "}
                · FY{doc.fy} · Item {chunk.item}
              </h3>
              <a
                href={doc.url}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-blue-700 underline"
              >
                Open on SEC.gov
              </a>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {chunk.heading_path.join(" › ")}
            </p>
            <div className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800">
              <PassageText
                text={chunk.text}
                sentence={isActive ? active?.sentence : undefined}
              />
            </div>
            <p className="mt-2 text-xs text-slate-500">
              RRF {candidate.fused.score.toFixed(4)} ·{" "}
              {rank("BM25", candidate.lexical)} ·{" "}
              {rank("dense", candidate.dense)}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
