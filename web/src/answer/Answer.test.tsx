// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Passage } from "../search/protocol";
import { Answer } from "./Answer";
import { answerBlocks } from "./render";
import type { AnswerState } from "./useAnswer";

afterEach(cleanup);

const passage = (
  id: string,
  company: string,
  fy: number,
  text = "t",
): Passage => ({
  candidate: {
    chunk_id: id,
    doc_id: `${company}-${fy}`,
    lexical: null,
    dense: null,
    fused: { rank: 1, score: 0.03 },
    rerank: null,
  },
  chunk: {
    text,
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

describe("sentence statuses", () => {
  const checked = [
    passage("a", "Apple", 2025, "Sales rose 5% in fiscal 2025."),
    passage("b", "NVIDIA", 2026, "Data center revenue grew."),
  ];
  const text = "Sales rose 5% [1]. Data center grew 9% [2]. Nothing else.";
  const badges = () =>
    [...document.querySelectorAll("[data-status]")].map((b) => [
      b.getAttribute("data-status"),
      b.textContent,
    ]);

  it("labels each sentence with an icon and a text status once done", () => {
    render(
      <Answer
        state={state(text)}
        sources={checked}
        active={null}
        onCite={() => {}}
      />,
    );
    expect(badges()).toEqual([
      [
        "verified",
        "✓Verified: Cited, and every number appears in the cited passage",
      ],
      ["unverified", "?Unverified: Not in the cited passage: 9%"],
      ["unverified", "?Unverified: No citation"],
    ]);
    expect(screen.getByTestId("checks").textContent).toContain(
      "1 verified · 2 unverified",
    );
  });

  it("shows no statuses while streaming", () => {
    render(
      <Answer
        state={state(text, "streaming")}
        sources={checked}
        active={null}
        onCite={() => {}}
      />,
    );
    expect(badges()).toEqual([]);
    expect(screen.queryByTestId("checks")).toBeNull();
  });

  it("asks the judge and applies its verdicts to this answer only", () => {
    const onJudge = vi.fn();
    const { rerender } = render(
      <Answer
        state={state(text)}
        sources={checked}
        active={null}
        onCite={() => {}}
        onJudge={onJudge}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Check with AI judge" }),
    );
    expect(onJudge).toHaveBeenCalledOnce();

    const result = {
      verdicts: [
        { plain: "Sales rose 5%.", supported: false, reason: "wrong year" },
        { plain: "Data center grew 9%.", supported: true, reason: "" },
      ],
      provider: "groqJudge",
      model: "qwen/qwen3.8-27b",
      judgeVersion: "support-v1",
      cached: false,
    };
    const props = {
      sources: checked,
      active: null,
      onCite: () => {},
      onJudge,
    };
    rerender(
      <Answer
        {...props}
        state={state(text)}
        judge={{ status: "done", answer: text, result }}
      />,
    );
    expect(badges().map(([s]) => s)).toEqual([
      "unsupported",
      "unverified", // the judge can't clear a number the check didn't find
      "unverified",
    ]);
    expect(badges()[0]?.[1]).toBe("✗Unsupported: AI judge: wrong year");
    expect(screen.getByTestId("judge-status").textContent).toBe(
      "Judged by qwen/qwen3.8-27b: 1 of 2 cited sentences supported.",
    );
    expect(
      screen.getByRole("button", { name: "Checked by AI judge" }),
    ).toHaveProperty("disabled", true);

    rerender(
      <Answer
        {...props}
        state={state("Other answer [1].")}
        judge={{ status: "done", answer: text, result }}
      />,
    );
    expect(badges().map(([s]) => s)).toEqual(["verified"]);
  });

  it("shows a friendly message when the judge is out of quota", () => {
    render(
      <Answer
        state={state(text)}
        sources={checked}
        active={null}
        onCite={() => {}}
        onJudge={() => {}}
        judge={{ status: "error", answer: text, reason: "quota" }}
      />,
    );
    expect(screen.getByTestId("judge-status").textContent).toContain(
      "free quota",
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
