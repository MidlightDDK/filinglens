// `pnpm eval:retrieval --config <id|all> --split dev|test|all [--limit N]
//   [--gate] [--write-baseline] [--report]`
// Runs the production retrieval code (packages/core) over the golden set →
// evals/results/<ts>/{retrieval.jsonl, summary.json, summary.md}.
//   --gate            fail if the default config's recall@10 drops by more than
//                     2 points vs evals/baseline.json
//   --write-baseline  save the default config's metrics as the new baseline
//   --report          write evals/reports/latest.json (metrics only)
import { execSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { parseArgs } from "node:util";
import {
  ChunkStore,
  type LoadedIndex,
  loadIndex,
  type Reranker,
  type RetrievalConfig,
  retrieve,
} from "@filinglens/core";
import {
  fsIndexSource,
  loadNodeEmbedder,
  loadNodeReranker,
} from "@filinglens/core/node";
import {
  CATEGORIES,
  EVALS_DIR,
  type GoldItem,
  loadGolden,
  type Split,
  sha256,
  TEXT_DIR,
  TEXT_HASHES_PATH,
} from "./dataset.ts";
import {
  type Aggregate,
  type ChunkSpan,
  countRelevant,
  METRICS,
  mean,
  percentile,
  type Scores,
  scoreRanking,
} from "./metrics.ts";

const CONFIGS_DIR = `${EVALS_DIR}/configs`;
const RESULTS_DIR = `${EVALS_DIR}/results`;
const BASELINE_PATH = `${EVALS_DIR}/baseline.json`;
const REPORT_PATH = `${EVALS_DIR}/reports/latest.json`;
const GATE_MAX_DROP = 0.02; // recall@10, absolute

export interface ConfigSummary {
  config: RetrievalConfig;
  overall: Aggregate;
  per_category: Partial<Record<string, Aggregate>>;
  /** Items without gold spans (e.g. unanswerable), not scored. */
  unscored: number;
  /** Node + onnxruntime-web (WASM), end to end per query. */
  latency_ms: { p50: number; p95: number };
}

interface Baseline extends Scores {
  config: string;
  split: Split | "all";
  dataset_sha256: string;
  commit: string | null;
}

function loadConfigs(arg: string): RetrievalConfig[] {
  const ids =
    arg === "all"
      ? readdirSync(CONFIGS_DIR)
          .filter((f) => f.endsWith(".json"))
          .map((f) => f.slice(0, -5))
          .sort((a, b) =>
            a === "default" ? -1 : b === "default" ? 1 : a < b ? -1 : 1,
          )
      : arg.split(",");
  return ids.map(
    (id) =>
      JSON.parse(
        readFileSync(`${CONFIGS_DIR}/${id}.json`, "utf8"),
      ) as RetrievalConfig,
  );
}

/** Gold spans are offsets into data/processed/text; they must not have moved. */
function changedTexts(): string[] {
  if (!existsSync(TEXT_HASHES_PATH)) return [];
  const hashes = JSON.parse(readFileSync(TEXT_HASHES_PATH, "utf8")) as Record<
    string,
    string
  >;
  return Object.entries(hashes)
    .filter(([doc, h]) => {
      const path = `${TEXT_DIR}/${doc}.txt`;
      return existsSync(path) && sha256(readFileSync(path, "utf8")) !== h;
    })
    .map(([doc]) => doc);
}

function commit(): string | null {
  try {
    const sha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", {
      encoding: "utf8",
    }).trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return null;
  }
}

const pct = (x: number) => (x * 100).toFixed(1);

function markdown(
  split: string,
  items: GoldItem[],
  summaries: Record<string, ConfigSummary>,
  gateLine: string | null,
): string {
  const ids = Object.keys(summaries);
  const scored = summaries[ids[0] ?? ""]?.overall.n ?? 0;
  const lines = [
    `### Retrieval eval: ${split} split, ${items.length} items (${scored} with gold spans)`,
    "",
    "| config | recall@5 | recall@10 | MRR@10 | nDCG@10 | p50 ms | p95 ms |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...ids.map((id) => {
      const s = summaries[id] as ConfigSummary;
      const m = METRICS.map((k) => pct(s.overall[k]));
      return `| ${id} | ${m.join(" | ")} | ${s.latency_ms.p50} | ${s.latency_ms.p95} |`;
    }),
    "",
    "Recall@10 by category:",
    "",
    `| category | n | ${ids.join(" | ")} |`,
    `|---|---:|${ids.map(() => "---:").join("|")}|`,
  ];
  for (const c of CATEGORIES) {
    const first = summaries[ids[0] ?? ""]?.per_category[c];
    if (!first) continue;
    const cells = ids.map((id) => {
      const a = summaries[id]?.per_category[c];
      return a ? pct(a.recall_at_10) : "";
    });
    lines.push(`| ${c} | ${first.n} | ${cells.join(" | ")} |`);
  }
  lines.push("", "Metrics in %; latency is Node + WASM per query.");
  if (gateLine) lines.push("", gateLine);
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<number> {
  const { values: args } = parseArgs({
    options: {
      config: { type: "string", default: "default" },
      split: { type: "string", default: "dev" },
      limit: { type: "string" },
      gate: { type: "boolean", default: false },
      "write-baseline": { type: "boolean", default: false },
      report: { type: "boolean", default: false },
    },
  });
  const split = args.split as Split | "all";
  if (!["dev", "test", "all"].includes(split)) {
    throw new Error("--split must be dev, test, or all");
  }
  const moved = changedTexts();
  if (moved.length > 0) {
    console.error(
      `Doc texts changed since the gold spans were anchored: ${moved.join(", ")}.\n` +
        "Gold spans are offsets into data/processed/text; re-anchor them before evaluating.",
    );
    return 1;
  }

  let items = loadGolden(split);
  if (args.limit) items = items.slice(0, Number(args.limit));
  const datasetSha = sha256(JSON.stringify(items));
  const configs = loadConfigs(args.config);
  if (
    (args.gate || args["write-baseline"]) &&
    !configs.some((c) => c.id === "default")
  ) {
    throw new Error("--gate and --write-baseline need the default config");
  }

  const source = fsIndexSource();
  const indexes = new Map<
    string,
    {
      index: LoadedIndex;
      store: ChunkStore;
      spans: Map<string, ChunkSpan[]>;
      byId: Map<string, ChunkSpan>;
    }
  >();
  const embedder = await loadNodeEmbedder("wasm");
  let reranker: Reranker | undefined;

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = `${RESULTS_DIR}/${ts}`;
  mkdirSync(outDir, { recursive: true });
  const perItem: string[] = [];
  const summaries: Record<string, ConfigSummary> = {};

  for (const config of configs) {
    const t0 = performance.now();
    let loaded = indexes.get(config.strategy);
    if (!loaded) {
      const index = await loadIndex(source, config.strategy);
      const store = new ChunkStore(source, config.strategy);
      const records = await store.get(index.rows.chunk_ids);
      const byId = new Map<string, ChunkSpan>();
      const spans = new Map<string, ChunkSpan[]>();
      for (const [id, r] of records) {
        const span = {
          doc_id: r.doc_id,
          char_start: r.char_start,
          char_end: r.char_end,
        };
        byId.set(id, span);
        spans.set(r.doc_id, [...(spans.get(r.doc_id) ?? []), span]);
      }
      loaded = { index, store, spans, byId };
      indexes.set(config.strategy, loaded);
    }
    if (config.rerank && !reranker) reranker = await loadNodeReranker("wasm");

    const scores: { category: string; s: Scores }[] = [];
    const latency: number[] = [];
    let unscored = 0;
    for (const item of items) {
      const res = await retrieve(loaded.index, item.question, config, {
        embedder,
        reranker,
        chunks: loaded.store,
      });
      const top = res.candidates.slice(0, 10);
      const ranked = top.map((c) => loaded.byId.get(c.chunk_id) as ChunkSpan);
      const docs = [...new Set(item.gold_spans.map((g) => g.doc_id))];
      const pool = docs.flatMap((d) => loaded.spans.get(d) ?? []);
      const s = scoreRanking(
        ranked,
        item.gold_spans,
        countRelevant(pool, item.gold_spans),
      );
      latency.push(res.timings.total_ms);
      if (s) scores.push({ category: item.category, s });
      else unscored++;
      perItem.push(
        JSON.stringify({
          config: config.id,
          id: item.id,
          category: item.category,
          scores: s,
          filters: res.filters,
          top: top.map((c) => c.chunk_id),
          timings: res.timings,
        }),
      );
    }
    const per_category: Partial<Record<string, Aggregate>> = {};
    for (const c of CATEGORIES) {
      const rows = scores.filter((r) => r.category === c).map((r) => r.s);
      if (rows.length) per_category[c] = mean(rows);
    }
    summaries[config.id] = {
      config,
      overall: mean(scores.map((r) => r.s)),
      per_category,
      unscored,
      latency_ms: {
        p50: Math.round(percentile(latency, 0.5)),
        p95: Math.round(percentile(latency, 0.95)),
      },
    };
    const o = summaries[config.id]?.overall as Aggregate;
    console.log(
      `${config.id.padEnd(14)} recall@10 ${pct(o.recall_at_10)}  MRR@10 ${pct(o.mrr_at_10)}  ` +
        `(${items.length} items, ${((performance.now() - t0) / 1000).toFixed(1)} s)`,
    );
  }

  const run = commit();
  let exit = 0;
  let gateLine: string | null = null;
  const def = summaries.default;
  if (args.gate && def) {
    const base = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
    if (base.dataset_sha256 !== datasetSha || base.split !== split) {
      gateLine = `❌ Gate: the ${split} set differs from the baseline's; rerun with --write-baseline and commit evals/baseline.json.`;
      exit = 1;
    } else {
      const drop = base.recall_at_10 - def.overall.recall_at_10;
      const ok = drop <= GATE_MAX_DROP + 1e-9;
      gateLine = `${ok ? "✅" : "❌"} Gate: recall@10 ${pct(def.overall.recall_at_10)} vs baseline ${pct(base.recall_at_10)} (limit: a drop of ${pct(GATE_MAX_DROP)} points).`;
      if (!ok) exit = 1;
    }
    console.log(gateLine);
  }
  if (args["write-baseline"] && def) {
    const base: Baseline = {
      config: "default",
      split,
      dataset_sha256: datasetSha,
      commit: run,
      ...Object.fromEntries(METRICS.map((m) => [m, def.overall[m]])),
    } as Baseline;
    writeFileSync(BASELINE_PATH, `${JSON.stringify(base, null, 2)}\n`);
    console.log("Wrote evals/baseline.json");
  }

  const summary = {
    created_at: new Date().toISOString(),
    commit: run,
    split,
    dataset: { items: items.length, sha256: datasetSha },
    configs: summaries,
  };
  const md = markdown(split, items, summaries, gateLine);
  writeFileSync(`${outDir}/retrieval.jsonl`, `${perItem.join("\n")}\n`);
  writeFileSync(
    `${outDir}/summary.json`,
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  writeFileSync(`${outDir}/summary.md`, md);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  if (args.report) {
    mkdirSync(`${EVALS_DIR}/reports`, { recursive: true });
    const { configs: retrieval, ...meta } = summary;
    const report = { ...meta, retrieval };
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log("Wrote evals/reports/latest.json");
  }
  console.log(`Results: evals/results/${ts}/`);
  return exit;
}

if (import.meta.main) process.exitCode = await main();
