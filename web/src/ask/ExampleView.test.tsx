// @vitest-environment jsdom
import type { Candidate, ExampleFile } from "@filinglens/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import comparison from "../../public/examples/comparison.json";
import outOfScope from "../../public/examples/out-of-scope.json";
import { ExampleView } from "./ExampleView";
import { EXAMPLES } from "./examples";
import { rerankMove } from "./UnderTheHood";

afterEach(cleanup);

// jsdom has no layout; the highlight scrolls itself into view.
Element.prototype.scrollIntoView = vi.fn();

const view = (example: ExampleFile, onRunLive = vi.fn()) =>
  render(
    <ExampleView
      example={example}
      active={null}
      onCite={vi.fn()}
      onRunLive={onRunLive}
      running={false}
      canRun
    />,
  );

describe("ExampleView (the committed precomputed examples)", () => {
  it("covers every chip with a file for the same question", async () => {
    for (const ex of EXAMPLES) {
      const file = (await import(`../../public/examples/${ex.id}.json`))
        .default as ExampleFile;
      expect(file.question).toBe(ex.question);
      expect(file.answer.chunkIds).toEqual(
        file.retrieval.passages.map((p) => p.candidate.chunk_id),
      );
    }
  });

  it("renders a cited, verified, judged answer with its metadata", () => {
    const onRunLive = vi.fn();
    view(comparison as ExampleFile, onRunLive);
    expect(screen.getByTestId("answer-text").textContent).toMatch(/Apple/);
    const statuses = [...document.querySelectorAll("[data-status]")].map((el) =>
      el.getAttribute("data-status"),
    );
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((s) => s === "verified")).toBe(true);
    expect(screen.getByTestId("judge-status").textContent).toMatch(
      /Judged by .+: \d+ of \d+ cited sentences supported/,
    );
    expect(screen.getByTestId("answer-meta").textContent).toMatch(/via groq/);
    expect(screen.getByText(/precomputed by pnpm examples/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run live" }));
    expect(onRunLive).toHaveBeenCalledOnce();
  });

  it("shows the out-of-scope example as declined, with sources", () => {
    view(outOfScope as ExampleFile);
    expect(screen.getByTestId("insufficient")).toBeTruthy();
    expect(document.querySelectorAll("[data-chunk-id]").length).toBeGreaterThan(
      0,
    );
  });
});

describe("rerankMove", () => {
  const cand = (fused: number, rerank: number | null) =>
    ({
      fused: { rank: fused, score: 0 },
      rerank: rerank === null ? null : { rank: rerank, score: 0 },
    }) as Candidate;

  it("shows how far the reranker moved a candidate", () => {
    expect(rerankMove(cand(5, 2))).toBe("↑3");
    expect(rerankMove(cand(1, 4))).toBe("↓3");
    expect(rerankMove(cand(2, 2))).toBe("=");
    expect(rerankMove(cand(2, null))).toBe("");
  });
});
