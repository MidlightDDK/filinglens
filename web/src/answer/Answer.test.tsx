// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Passage } from "../search/protocol";
import { Answer } from "./Answer";
import { answerBlocks } from "./render";
import type { AnswerState } from "./useAnswer";

afterEach(cleanup);

const passage = (id: string, company: string, fy: number): Passage => ({
  candidate: {
    chunk_id: id,
    doc_id: `${company}-${fy}`,
    lexical: null,
    dense: null,
    fused: { rank: 1, score: 0.03 },
    rerank: null,
  },
  chunk: {
    text: "t",
    doc_id: `${company}-${fy}`,
    item: "7",
    heading_path: [],
    char_start: 0,
    char_end: 1,
  },
  doc: {
    company,
    ticker: company.toUpperCase(),
    aliases: [],
    fy,
    filing_date: "2025-01-01",
    url: "https://www.sec.gov/x",
  },
});
const sources = [passage("a", "Apple", 2025), passage("b", "NVIDIA", 2026)];

const state = (
  text: string,
  status: AnswerState["status"] = "done",
  extra: Partial<AnswerState> = {},
): AnswerState =>
  ({
    status,
    question: "q",
    chunkIds: ["a", "b"],
    text,
    ...extra,
  }) as AnswerState;

describe("Answer", () => {
  it("renders markers as labelled chips and reports clicks with the sentence", () => {
    const onCite = vi.fn();
    render(
      <Answer
        state={state("Sales rose 5% [1]. Data center grew [2][9].")}
        sources={sources}
        active={null}
        onCite={onCite}
      />,
    );
    const chips = screen.getAllByRole("button");
    expect(chips.map((c) => c.getAttribute("aria-label"))).toEqual([
      "Source 1: Apple FY2025, Item 7",
      "Source 2: NVIDIA FY2026, Item 7",
    ]); // [9] points outside SOURCES and is dropped
    expect(screen.getByTestId("answer-text").textContent).toContain(
      "Sales rose 5% 1.",
    );
    fireEvent.click(chips[1] as HTMLElement);
    expect(onCite).toHaveBeenCalledWith({
      n: 2,
      sentence: "Data center grew.",
    });
  });

  it("marks the active chip as pressed", () => {
    render(
      <Answer
        state={state("A [1]. B [1].")}
        sources={sources}
        active={{ n: 1, sentence: "B." }}
        onCite={() => {}}
      />,
    );
    const pressed = screen
      .getAllByRole("button")
      .map((c) => c.getAttribute("aria-pressed"));
    expect(pressed).toEqual(["false", "true"]);
  });

  it("shows the insufficient-evidence card, not the raw marker", () => {
    render(
      <Answer
        state={state("INSUFFICIENT_EVIDENCE: Tesla is not in the corpus.")}
        sources={sources}
        active={null}
        onCite={() => {}}
      />,
    );
    expect(screen.getByTestId("insufficient").textContent).toContain(
      "Tesla is not in the corpus.",
    );
    expect(screen.queryByText(/INSUFFICIENT_EVIDENCE/)).toBeNull();
  });

  it("hides a partial INSUFFICIENT_EVIDENCE prefix while streaming", () => {
    render(
      <Answer
        state={state("INSUFF", "streaming")}
        sources={sources}
        active={null}
        onCite={() => {}}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Writing");
    expect(screen.queryByTestId("answer-text")).toBeNull();
  });

  it("asks for the Turnstile check instead of claiming to write", () => {
    render(
      <Answer
        state={state("", "pending")}
        sources={sources}
        active={null}
        onCite={() => {}}
        checkNeeded
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Complete the Cloudflare check",
    );
  });

  it("shows a friendly quota message", () => {
    render(
      <Answer
        state={state("", "error", { reason: "quota" })}
        sources={sources}
        active={null}
        onCite={() => {}}
      />,
    );
    expect(screen.getByTestId("answer-error").textContent).toContain(
      "free AI quota",
    );
  });

  it("shows provider, latency, tokens, and cache state when done", () => {
    render(
      <Answer
        state={state("A [1].", "done", {
          done: {
            provider: "groq",
            model: "openai/gpt-oss-120b",
            promptVersion: "answer-v1",
            usage: { prompt_tokens: 100, completion_tokens: 20 },
            latencyMs: 1234,
            cached: true,
          },
        })}
        sources={sources}
        active={null}
        onCite={() => {}}
      />,
    );
    expect(screen.getByTestId("answer-meta").textContent).toBe(
      "openai/gpt-oss-120b via groq · 1.2 s · 120 tokens · cached",
    );
  });
});

describe("answerBlocks", () => {
  it("splits paragraphs and list items into sentences, dropping emphasis", () => {
    expect(
      answerBlocks(
        "**Summary.** Two points [1].\n\n- First [1].\n2. Second [2].",
      ),
    ).toEqual([
      { kind: "p", sentences: ["Summary.", "Two points [1]."] },
      { kind: "li", sentences: ["First [1]."] },
      { kind: "li", sentences: ["Second [2]."] },
    ]);
  });
});
