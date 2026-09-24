// Example chips, /evals, and /lab. The chips must work with every provider,
// the API, and even the search index unreachable; /evals and /lab read the
// committed eval report as their fixture.
import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const report = readFileSync(
  new URL("../../evals/reports/latest.json", import.meta.url),
  "utf8",
);
const history = [
  {
    label: "2026-09-24-m3",
    created_at: "2026-09-24T12:20:18.372Z",
    commit: "fe69e66c86cb88f1e85ca19eb51993758dad240b",
    items: 64,
    retrieval: {
      recall_at_5: 0.9,
      recall_at_10: 0.9453,
      mrr_at_10: 0.7,
      ndcg_at_10: 0.6,
      n: 64,
    },
    answers: null,
  },
];

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

async function fixtures(page: Page) {
  await page.route("**/evals/latest.json", (route) =>
    route.fulfill({ contentType: "application/json", body: report }),
  );
  await page.route("**/evals/history.json", (route) =>
    route.fulfill({ json: history }),
  );
}

test("example chips render instantly with the API and index down", async ({
  page,
}) => {
  const errors = watchErrors(page);
  const api: string[] = [];
  await page.route("**/api/**", (route) => {
    api.push(route.request().url());
    return route.abort();
  });
  await page.route("**/index/**", (route) => route.abort());
  await page.route("https://challenges.cloudflare.com/**", (route) =>
    route.abort(),
  );
  await page.goto("/");

  const chips = page.locator("[data-example]");
  await expect(chips).toHaveCount(6);
  for (const chip of await chips.all()) {
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByTestId("answer-text").or(page.getByTestId("insufficient")),
    ).toBeVisible({ timeout: 2_000 });
    await expect(page.getByRole("button", { name: "Run live" })).toBeVisible();
  }

  // A citation highlights its passage; statuses and the judge are shown.
  await page.locator('[data-example="trend"]').click();
  const cite = page.getByRole("button", { name: /^Source \d+:/ }).first();
  await cite.click();
  await expect(
    page.locator("[data-active] [data-testid=highlight]"),
  ).toBeVisible();
  await expect(page.locator("[data-status=verified]").first()).toBeVisible();
  await expect(page.getByTestId("judge-status")).toContainText("Judged by");
  expect(api).toEqual([]);
  expect(errors).toEqual([]);
});

test("/evals renders the report", async ({ page }) => {
  const errors = watchErrors(page);
  await fixtures(page);
  await page.goto("/");
  await page.getByRole("link", { name: "Evals" }).click();
  await expect(page).toHaveURL(/\/evals$/);
  for (const name of [
    "Dataset",
    "Answer quality",
    "Judge agreement",
    "Retrieval configs",
    "Trend across releases",
    "Failure examples",
  ]) {
    await expect(page.getByRole("heading", { name })).toBeVisible();
  }
  await expect(page.getByTestId("judge-agreement")).toContainText("Support");
  await expect(page.locator("[data-failure]").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("/lab compares two configs live", async ({ page }) => {
  test.setTimeout(600_000);
  const errors = watchErrors(page);
  await fixtures(page);
  await page.goto("/lab?device=wasm");
  await expect(
    page.getByTestId("config-table").locator("[data-config]"),
  ).toHaveCount(6);

  await page
    .getByLabel("Config B", { exact: true })
    .selectOption("lexical-only");
  await page.getByRole("button", { name: "Compare retrieval" }).click();
  const a = page.getByTestId("lab-side-A");
  const b = page.getByTestId("lab-side-B");
  await expect(a).toBeVisible({ timeout: 480_000 });
  await expect(a).toContainText("default");
  await expect(b).toContainText("lexical-only");
  await expect(a.locator("[data-chunk-id]")).toHaveCount(8);
  await expect(b.locator("[data-chunk-id]")).toHaveCount(8);
  await expect(page.getByTestId("lab-overlap")).toContainText(/\d of 8/);

  // Lazily loaded on first use: the second index and the reranker model.
  await page.getByLabel("Config A", { exact: true }).selectOption("fixed");
  await page.getByLabel("Config B", { exact: true }).selectOption("rerank");
  await page.getByRole("button", { name: "Compare retrieval" }).click();
  await expect(a).toContainText("fixed", { timeout: 300_000 });
  await expect(b).toContainText("rerank");
  await expect(b).toContainText(/rerank [-\d.]+ \(RRF #\d+\)/);
  await expect(a.locator("[data-chunk-id]")).toHaveCount(8);
  await expect(b.locator("[data-chunk-id]")).toHaveCount(8);
  expect(errors).toEqual([]);
});
