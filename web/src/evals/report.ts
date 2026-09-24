// evals/reports/latest.json as the build copies it to /evals/latest.json, plus
// /evals/history.json (one point per dated release report). The shapes mirror
// what evals/src/{retrieval,answers}.ts write; only fields the UI reads.
import type { RetrievalConfig } from "@filinglens/core";
import { useEffect, useState } from "react";

export interface RetrievalMetrics {
  recall_at_5: number;
  recall_at_10: number;
  mrr_at_10: number;
  ndcg_at_10: number;
  n: number;
}

export interface ConfigSummary {
  config: RetrievalConfig;
  overall: RetrievalMetrics;
  per_category: Record<string, RetrievalMetrics>;
  unscored: number;
  latency_ms: { p50: number; p95: number };
}

type SplitCounts = { dev: number; test: number };

export interface Rate {
  value: number | null;
  n: number;
}

export interface SentenceDetail {
  text: string;
  status: string;
  reason: string | null;
  missing: string[];
}

export interface FailureExample {
  id: string;
  category: string;
  kind: "incorrect" | "unverified";
  question: string;
  gold_answer: string;
  answer: string;
  why: string;
  unverified: SentenceDetail[];
  note: string | null;
}

export interface AnswerReport {
  created_at: string;
  commit: string | null;
  split: string;
  dataset: { items: number; sampled: string };
  config: string;
  generator: { provider: string; model: string };
  prompt_version: string;
  judge: { model: string; correctness_version: string } | null;
  summary: {
    items: number;
    accuracy: Rate;
    numeric_em: Rate;
    judge_correct: Rate;
    false_premise_correction: Rate;
    abstention: {
      precision: number | null;
      recall: number | null;
      abstained: number;
      unanswerable: number;
    };
    sentences: number;
    citation_coverage: number | null;
    citation_precision: number | null;
    verified_rate: number | null;
    unsupported_rate: number | null;
    per_category: Record<string, { accuracy: number | null; n: number }>;
    latency_ms: Record<
      "retrieval" | "generation",
      { p50: number; p95: number }
    >;
    tokens: { in: number; out: number };
    providers: Record<string, number>;
  };
  failures?: FailureExample[];
}

export interface Agreement {
  n: number;
  agreement: number;
  kappa: number;
  disagreements: { id: string; human: string; judge: string; reason: string }[];
}

export interface Report {
  created_at: string;
  commit: string | null;
  split: string;
  dataset: {
    items: number;
    sha256: string;
    composition?: {
      total: SplitCounts;
      categories: Record<string, SplitCounts>;
      sources: Record<string, SplitCounts>;
    };
  };
  retrieval: Record<string, ConfigSummary>;
  answers?: AnswerReport;
  judge?: {
    created_at: string;
    judge_model: string;
    correctness_version: string;
    support_version: string;
    correctness: Agreement;
    support: Agreement;
  };
}

/** One release in the trend (built from evals/reports/<date>*.json). */
export interface TrendPoint {
  label: string;
  created_at: string;
  commit: string | null;
  items: number;
  retrieval: RetrievalMetrics | null;
  answers: {
    items: number;
    accuracy: number | null;
    numeric_em: number | null;
    citation_coverage: number | null;
    verified_rate: number | null;
  } | null;
}

const cache = new Map<string, Promise<unknown>>();

function getJson<T>(url: string): Promise<T> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url).then((res) => {
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return res.json();
    });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p as Promise<T>;
}

export type Loaded<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error" };

export function useJson<T>(url: string): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  useEffect(() => {
    let live = true;
    getJson<T>(url).then(
      (data) => live && setState({ status: "ready", data }),
      () => live && setState({ status: "error" }),
    );
    return () => {
      live = false;
    };
  }, [url]);
  return state;
}

export const useReport = () => useJson<Report>("/evals/latest.json");

export const pct = (x: number | null | undefined, digits = 1) =>
  x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(digits)}%`;

export const REPO = "https://github.com/MidlightDDK/filinglens";

export const commitUrl = (commit: string) =>
  `${REPO}/commit/${commit.replace(/-dirty$/, "")}`;
