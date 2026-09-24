// Runs locally and, daily, against the live site (smoke.yml). Against the live
// site it also checks the Content-Security-Policy from web/public/_headers
// (vite dev serves no CSP): loading the page, the search model and index, and
// one example must cause no violations.
import { expect, test } from "@playwright/test";

test("home page and one example, no console errors or CSP violations", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  await page.addInitScript({
    content: `addEventListener("securitypolicyviolation", (e) =>
      console.error("CSP violation: " + e.violatedDirective + " " + e.blockedURI));`,
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "FilingLens" }),
  ).toBeVisible();

  const chip = page.locator('[data-example="lookup"]');
  await chip.click();
  await expect(page.getByTestId("answer-text")).toBeVisible({ timeout: 2_000 });
  await expect(
    page.getByRole("button", { name: /^Source \d+:/ }).first(),
  ).toBeVisible();

  // The search model and index load after first paint; wait for them so
  // their downloads (Hugging Face, jsDelivr WASM) are covered by the CSP check.
  await expect(page.getByTestId("load-status")).toContainText(/ready/i, {
    timeout: 150_000,
  });
  expect(errors).toEqual([]);
});
