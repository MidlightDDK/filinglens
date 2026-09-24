import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Transformers.js points onnxruntime-web at its WASM on cdn.jsdelivr.net at
// runtime; the bundled fallback copy (~27 MB) is never fetched and exceeds the
// 25 MiB Workers static-asset limit, so drop it from the build.
const dropOrtWasm = (): Plugin => ({
  name: "drop-ort-wasm",
  generateBundle(_, bundle) {
    for (const name of Object.keys(bundle)) {
      if (/ort-wasm[^/]*\.wasm$/.test(name)) delete bundle[name];
    }
  },
});

const REPORTS = new URL("../evals/reports/", import.meta.url);
const OUT = new URL("./public/evals/", import.meta.url);

// A release report's headline numbers, for the /evals trend table.
// biome-ignore lint/suspicious/noExplicitAny: report JSON, shaped by evals/src
function trendPoint(label: string, r: any) {
  const s = r.answers?.summary;
  return {
    label,
    created_at: r.created_at,
    commit: r.commit,
    split: r.split,
    items: r.dataset.items,
    retrieval: r.retrieval?.default?.overall ?? null,
    answers: s
      ? {
          items: s.items,
          accuracy: s.accuracy.value,
          numeric_em: s.numeric_em.value,
          citation_coverage: s.citation_coverage,
          verified_rate: s.verified_rate,
        }
      : null,
  };
}

// Copies evals/reports/latest.json to /evals/latest.json and writes
// /evals/history.json from the dated release reports (evals/reports/<date>*.json)
// for the Lab and Evals pages. Both outputs are gitignored.
const evalsReports = (): Plugin => ({
  name: "evals-reports",
  buildStart() {
    const read = (name: string) =>
      JSON.parse(readFileSync(new URL(name, REPORTS), "utf8"));
    const latest = read("latest.json");
    const history = readdirSync(REPORTS)
      .filter((f) => /^\d{4}-\d{2}-\d{2}.*\.json$/.test(f))
      .sort()
      .map((f) => trendPoint(f.replace(/\.json$/, ""), read(f)));
    if (!history.some((p) => p.created_at === latest.created_at)) {
      history.push(trendPoint("latest", latest));
    }
    mkdirSync(OUT, { recursive: true });
    writeFileSync(new URL("latest.json", OUT), JSON.stringify(latest));
    writeFileSync(new URL("history.json", OUT), JSON.stringify(history));
  },
});

export default defineConfig({
  plugins: [react(), tailwindcss(), dropOrtWasm(), evalsReports()],
  // The search worker imports Transformers.js, which code-splits.
  worker: { format: "es", plugins: () => [dropOrtWasm()] },
  server: {
    // `pnpm dev` runs `wrangler dev` (worker/) on its default port alongside
    // Vite. The Worker accepts same-origin POSTs only, so present as its origin.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        headers: { origin: "http://127.0.0.1:8787" },
      },
    },
  },
});
