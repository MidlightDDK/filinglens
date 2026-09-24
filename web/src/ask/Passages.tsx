import type { Ranked } from "@filinglens/core";
import type { Passage } from "../search/protocol";

const rank = (label: string, r: Ranked | null) =>
  r ? `${label} #${r.rank}` : `${label}: not in top 50`;

export function Passages({ passages }: { passages: Passage[] }) {
  if (passages.length === 0) {
    return <p className="text-slate-600">No matching passages.</p>;
  }
  return (
    <ol className="flex flex-col gap-4">
      {passages.map(({ candidate, chunk, doc }, i) => (
        <li
          key={candidate.chunk_id}
          data-chunk-id={candidate.chunk_id}
          className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="font-medium">
              <span className="text-slate-400">#{i + 1}</span> {doc.company} ·
              FY{doc.fy} · Item {chunk.item}
            </h2>
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
            {chunk.text}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            RRF {candidate.fused.score.toFixed(4)} ·{" "}
            {rank("BM25", candidate.lexical)} · {rank("dense", candidate.dense)}
          </p>
        </li>
      ))}
    </ol>
  );
}
