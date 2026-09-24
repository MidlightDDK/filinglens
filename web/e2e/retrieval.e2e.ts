// Node vs browser parity: the same queries through @filinglens/core must give
// identical top-10 chunk ids in Node (onnxruntime-node) and in the browser's
// Web Worker (WASM). Needs the local index (`pnpm index`) and network access
// to huggingface.co and cdn.jsdelivr.net for the model and runtime.
import { existsSync, readFileSync } from "node:fs";
import { loadIndex, type RetrievalConfig, retrieve } from "@filinglens/core";
import {
  fsIndexSource,
  INDEX_DIR,
  loadNodeEmbedder,
  REPO_ROOT,
} from "@filinglens/core/node";
import { expect, test } from "@playwright/test";

const config: RetrievalConfig = JSON.parse(
  readFileSync(`${REPO_ROOT}evals/configs/default.json`, "utf8"),
);

const QUERIES = [
  "What was NVIDIA's data center revenue in fiscal 2026?",
  "Apple iPhone net sales FY2025",
  "How does Coca-Cola describe currency exchange risk?",
  "JPMorgan common equity tier 1 capital ratio",
  "Which companies mention export controls on AI chips?",
];

test.skip(
  !existsSync(`${INDEX_DIR}/${config.strategy}/meta.json`),
  "index not built; run `pnpm index`",
);

test("Node and browser return identical top-10 ids", async ({ page }) => {
  test.setTimeout(600_000);

  const index = await loadIndex(fsIndexSource(), config.strategy);
  const embedder = await loadNodeEmbedder();
  const expected: string[][] = [];
  for (const q of QUERIES) {
    const r = await retrieve(index, q, config, { embedder });
    expected.push(r.candidates.slice(0, 10).map((c) => c.chunk_id));
  }

  await page.goto("/?device=wasm");
  await expect(page.getByTestId("load-status")).toContainText("Ready", {
    timeout: 480_000,
  });

  const wallMs: number[] = [];
  for (const [i, q] of QUERIES.entries()) {
    await page.getByRole("searchbox").fill(q);
    await page.getByRole("button", { name: "Ask" }).click();
    await expect(page.getByTestId("result-summary")).toContainText(q);
    const ids = await page
      .getByTestId("candidates")
      .locator("tbody tr")
      .evaluateAll((rows) =>
        rows.slice(0, 10).map((r) => r.getAttribute("data-chunk-id")),
      );
    expect(ids, q).toEqual(expected[i]);
    wallMs.push(Number(await page.getByTestId("wall-ms").textContent()));
  }

  console.log(`query → passages (ms, after warm-up): ${wallMs.join(", ")}`);
  for (const ms of wallMs) expect(ms).toBeLessThan(1000);
});
