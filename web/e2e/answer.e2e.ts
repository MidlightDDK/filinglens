// Ask → streamed, cited answer → click a citation → highlighted source.
// The mocked test stubs Turnstile and /api/*, so it runs against any server;
// `E2E_LIVE=1` also runs one against the real gateway (e.g. `wrangler dev` or
// the deployed site via E2E_BASE_URL), which spends free-tier LLM quota.
import { expect, type Page, test } from "@playwright/test";

const APPLE = "How much did Apple's iPhone net sales change in fiscal 2025?";
const FRANCE = "What is the capital of France?";

async function ready(page: Page) {
  await page.goto("/?device=wasm");
  await expect(page.getByTestId("load-status")).toContainText("Ready", {
    timeout: 480_000,
  });
}

async function ask(page: Page, question: string) {
  await page.getByRole("searchbox").fill(question);
  await page.getByRole("button", { name: "Ask" }).click();
}

const sse = (text: string) =>
  `event: token\ndata: ${JSON.stringify({ text })}\n\n` +
  `event: done\ndata: ${JSON.stringify({
    provider: "workersAi",
    model: "mock-model",
    promptVersion: "mock",
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    latencyMs: 42,
    cached: false,
  })}\n\n`;

test("mocked gateway: chips, highlight, insufficient evidence, quota", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  await page.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `window.turnstile = {
        render(el, o) { setTimeout(() => o.callback("mock-token")); return "w"; },
        remove() {},
      };`,
    }),
  );
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: { expiresAt: Date.now() + 1_800_000 } }),
  );
  let reply = "";
  let status = 200;
  await page.route("**/api/answer", (route) =>
    status === 200
      ? route.fulfill({ contentType: "text/event-stream", body: sse(reply) })
      : route.fulfill({ status, json: { reason: "quota" } }),
  );

  await ready(page);

  reply = "Apple iPhone net sales changed in fiscal 2025 [1].";
  await ask(page, APPLE);
  const chip = page.getByRole("button", { name: /^Source 1:/ });
  await expect(chip).toBeVisible();
  await expect(page.getByTestId("answer-meta")).toContainText("mock-model");
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#source-1 [data-testid=highlight]")).toBeVisible();

  reply = "INSUFFICIENT_EVIDENCE: The filings do not cover French geography.";
  await ask(page, FRANCE);
  await expect(page.getByTestId("insufficient")).toContainText(
    "French geography",
  );

  status = 503;
  await ask(page, "What was Apple's revenue?");
  await expect(page.getByTestId("answer-error")).toContainText("free AI quota");
  expect(errors).toEqual([]);
});

test("live gateway: cited answer and out-of-scope question", async ({
  page,
}) => {
  test.skip(!process.env.E2E_LIVE, "set E2E_LIVE=1 to call real LLMs");
  test.setTimeout(600_000);
  await ready(page);

  await ask(page, APPLE);
  await expect(page.getByTestId("answer-meta")).toBeVisible({
    timeout: 60_000,
  });
  const chip = page.getByRole("button", { name: /^Source \d+:/ }).first();
  await chip.click();
  await expect(
    page.locator("[data-active] [data-testid=highlight]"),
  ).toBeVisible();
  console.log(
    `answer: ${await page.getByTestId("answer-text").textContent()}\n` +
      `meta: ${await page.getByTestId("answer-meta").textContent()}`,
  );

  await ask(page, FRANCE);
  await expect(page.getByTestId("insufficient")).toBeVisible({
    timeout: 60_000,
  });
});
