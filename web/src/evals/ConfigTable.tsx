import { CONFIG_NOTES } from "../configs";
import { type ConfigSummary, pct, type RetrievalMetrics } from "./report";

const COLUMNS: [keyof RetrievalMetrics, string][] = [
  ["recall_at_5", "Recall@5"],
  ["recall_at_10", "Recall@10"],
  ["mrr_at_10", "MRR@10"],
  ["ndcg_at_10", "nDCG@10"],
];

/** Retrieval configs × metrics from the latest eval run; best values in bold. */
export function ConfigTable({
  configs,
  marks = {},
}: {
  configs: Record<string, ConfigSummary>;
  /** Labels to show next to config ids, e.g. {default: "A"}. */
  marks?: Record<string, string>;
}) {
  const ids = Object.keys(configs);
  const best = (k: keyof RetrievalMetrics) =>
    Math.max(...ids.map((id) => configs[id]?.overall[k] ?? 0));
  return (
    <div className="overflow-x-auto">
      <table
        className="w-full min-w-[36rem] text-left text-sm tabular-nums"
        data-testid="config-table"
      >
        <thead className="text-slate-500">
          <tr className="border-b border-slate-200">
            <th className="py-1 pr-3 font-normal">Config</th>
            {COLUMNS.map(([k, label]) => (
              <th key={k} className="py-1 pr-3 text-right font-normal">
                {label}
              </th>
            ))}
            <th className="py-1 text-right font-normal">p50 latency</th>
          </tr>
        </thead>
        <tbody>
          {ids.map((id) => {
            const s = configs[id] as ConfigSummary;
            return (
              <tr
                key={id}
                data-config={id}
                className="border-b border-slate-100 align-top"
              >
                <td className="py-1.5 pr-3">
                  <span className="font-medium">{id}</span>
                  {marks[id] && (
                    <span className="ml-1.5 rounded bg-slate-900 px-1 text-xs font-semibold text-white">
                      {marks[id]}
                    </span>
                  )}
                  <span className="block text-xs text-slate-500">
                    {CONFIG_NOTES[id]}
                  </span>
                </td>
                {COLUMNS.map(([k]) => (
                  <td
                    key={k}
                    className={`py-1.5 pr-3 text-right ${
                      s.overall[k] === best(k) ? "font-semibold" : ""
                    }`}
                  >
                    {pct(s.overall[k])}
                  </td>
                ))}
                <td className="py-1.5 text-right">{s.latency_ms.p50} ms</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
