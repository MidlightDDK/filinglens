// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import latest from "../../../evals/reports/latest.json";
import { EvalsPage } from "./EvalsPage";
import type { Report, TrendPoint } from "./report";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const report = latest as unknown as Report;
const history: TrendPoint[] = [
  {
    label: "2026-09-24-m3",
    created_at: "2026-09-24T12:20:18.372Z",
    commit: "fe69e66",
    items: 64,
    retrieval: {
      recall_at_5: 0.8,
      recall_at_10: 0.9453,
      mrr_at_10: 0.7,
      ndcg_at_10: 0.6,
      n: 64,
    },
    answers: null,
  },
];

describe("EvalsPage (the committed evals/reports/latest.json)", () => {
  // First: report.ts caches successful fetches for the page's lifetime.
  it("says so when the report can't be loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    render(<EvalsPage />);
    await screen.findByText("The eval report couldn't be loaded.");
  });

  it("shows the dataset, answer metrics, judge agreement, configs, trend, and failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(url.endsWith("history.json") ? history : report),
      ),
    );
    render(<EvalsPage />);
    await screen.findByTestId("dataset-summary");

    const comp = report.dataset.composition;
    expect(comp).toBeDefined();
    const total = (comp?.total.dev ?? 0) + (comp?.total.test ?? 0);
    expect(screen.getByTestId("dataset-summary").textContent).toContain(
      `${total} questions`,
    );
    expect(screen.getByTestId("answer-metrics").textContent).toContain(
      `${((report.answers?.summary.accuracy.value ?? 0) * 100).toFixed(1)}%`,
    );
    expect(screen.getByTestId("judge-agreement").textContent).toContain(
      report.judge?.support.kappa.toFixed(2),
    );
    expect(
      screen.getByTestId("config-table").querySelectorAll("[data-config]"),
    ).toHaveLength(Object.keys(report.retrieval).length);
    await waitFor(() =>
      expect(screen.getByTestId("trend").textContent).toContain("94.5%"),
    );
    const failures = report.answers?.failures ?? [];
    expect(failures.length).toBeGreaterThan(0);
    expect(document.querySelectorAll("[data-failure]")).toHaveLength(
      failures.length,
    );
    expect(failures.every((f) => f.note)).toBe(true);
  });
});
