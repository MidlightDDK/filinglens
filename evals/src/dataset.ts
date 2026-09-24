// Eval dataset schema and I/O (see .claude/rules/evals.md).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { REPO_ROOT } from "@filinglens/core/node";

export const EVALS_DIR = `${REPO_ROOT}evals`;
export const DATASETS_DIR = `${EVALS_DIR}/datasets`;
export const GOLDEN_PATH = `${DATASETS_DIR}/golden.jsonl`;
export const XBRL_PATH = `${DATASETS_DIR}/xbrl_numeric.jsonl`;
export const REVIEW_DIR = `${EVALS_DIR}/review`;
export const TEXT_DIR = `${REPO_ROOT}data/processed/text`;
/** sha256 of each doc text the gold spans point into. */
export const TEXT_HASHES_PATH = `${DATASETS_DIR}/text_hashes.json`;

export const CATEGORIES = [
  "lookup",
  "table_number",
  "comparison",
  "trend",
  "multi_hop",
  "false_premise",
  "unanswerable",
] as const;
export type Category = (typeof CATEGORIES)[number];
export type Split = "dev" | "test";
export type Source = "xbrl" | "synthetic_reviewed" | "handwritten";

/**
 * Character offsets into data/processed/text/{doc_id}.txt. Spans that share a
 * `group` are interchangeable evidence for one fact; a span without a group is
 * its own group. Recall counts groups, so an item needs one span per group.
 */
export interface GoldSpan {
  doc_id: string;
  char_start: number;
  char_end: number;
  group?: string;
}

export interface GoldNumeric {
  value: number;
  unit: string;
  /** Absolute, in `unit`. */
  tolerance: number;
}

export interface GoldItem {
  id: string;
  question: string;
  category: Category;
  companies: string[];
  fiscal_years: number[];
  answerable: boolean;
  gold_answer: string;
  gold_numeric?: GoldNumeric;
  gold_spans: GoldSpan[];
  source: Source;
  split: Split;
}

export const sha256 = (s: string) =>
  createHash("sha256").update(s).digest("hex");

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

export function writeJsonl(path: string, rows: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

export function loadGolden(split: Split | "all"): GoldItem[] {
  const items = readJsonl<GoldItem>(GOLDEN_PATH);
  if (items.length === 0) {
    throw new Error(
      "evals/datasets/golden.jsonl is empty: run pnpm eval:import",
    );
  }
  return split === "all" ? items : items.filter((it) => it.split === split);
}

const texts = new Map<string, string>();

export function docText(docId: string): string {
  let text = texts.get(docId);
  if (text === undefined) {
    text = readFileSync(`${TEXT_DIR}/${docId}.txt`, "utf8");
    texts.set(docId, text);
  }
  return text;
}

// Curly quotes, dashes, and non-breaking spaces a reviewer may paste in.
const FOLD: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  " ": " ",
};

/** Whitespace-collapsed, punctuation-folded text plus a map back to offsets. */
function normalize(text: string): { norm: string; offsets: number[] } {
  let norm = "";
  const offsets: number[] = [];
  let space = false;
  for (let i = 0; i < text.length; i++) {
    const ch = FOLD[text[i] as string] ?? (text[i] as string);
    if (/\s/.test(ch)) {
      if (!space && norm.length > 0) {
        norm += " ";
        offsets.push(i);
      }
      space = true;
      continue;
    }
    space = false;
    norm += ch;
    offsets.push(i);
  }
  return { norm, offsets };
}

const normalized = new Map<string, ReturnType<typeof normalize>>();

/**
 * Offsets of `quote` in `text`, ignoring whitespace differences and curly
 * quotes. A quote that appears more than once resolves to the occurrence
 * nearest `near`, or to null without it. `key` caches the normalized text.
 */
export function locate(
  text: string,
  quote: string,
  { key, near }: { key?: string; near?: number } = {},
): { char_start: number; char_end: number } | null {
  let n = key ? normalized.get(key) : undefined;
  if (!n) {
    n = normalize(text);
    if (key) normalized.set(key, n);
  }
  const q = normalize(quote).norm.trim();
  if (!q) return null;
  const hits: { char_start: number; char_end: number }[] = [];
  for (let at = n.norm.indexOf(q); at >= 0; at = n.norm.indexOf(q, at + 1)) {
    hits.push({
      char_start: n.offsets[at] as number,
      char_end: (n.offsets[at + q.length - 1] as number) + 1,
    });
  }
  if (hits.length === 1) return hits[0] ?? null;
  if (hits.length === 0 || near === undefined) return null;
  const dist = (h: { char_start: number }) => Math.abs(h.char_start - near);
  return hits.reduce((best, h) => (dist(h) < dist(best) ? h : best));
}
