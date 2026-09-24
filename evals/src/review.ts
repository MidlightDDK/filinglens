// Review CSVs (evals/review/) ↔ gold items. Reviewers edit quotes, not offsets:
// `evidence` holds "DOC_ID: quote" entries separated by " || ", and import
// re-anchors each quote in data/processed/text/{doc_id}.txt.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { formatCsv, parseCsv, type Row } from "./csv.ts";
import {
  CATEGORIES,
  type Category,
  docText,
  type GoldItem,
  type GoldSpan,
  locate,
  REVIEW_DIR,
  type Source,
} from "./dataset.ts";

export const QUEUE_PATH = `${REVIEW_DIR}/queue.csv`;
export const HANDWRITTEN_PATH = `${REVIEW_DIR}/handwritten.csv`;

export const ITEM_COLUMNS = [
  "id",
  "category",
  "question",
  "gold_answer",
  "answerable",
  "companies",
  "fiscal_years",
  "evidence",
  "gold_value",
  "gold_unit",
  "gold_tolerance",
  "notes",
] as const;
/** The queue adds the reviewer's decision, machine span hints, and context. */
export const QUEUE_COLUMNS = [
  "id",
  "decision",
  ...ITEM_COLUMNS.slice(1),
  "spans",
  "context",
] as const;
export const DECISIONS = ["accept", "edit", "reject"] as const;

const SEP = " || ";
const DOC_ID = /^([A-Z][A-Z.]*-FY\d{4})\s*:\s*([\s\S]+)$/;
const HINT = /^([A-Z][A-Z.]*-FY\d{4}):(\d+)-(\d+)$/;

export function readCsv(path: string): Row[] {
  return existsSync(path) ? parseCsv(readFileSync(path, "utf8")) : [];
}

export function writeCsv(
  path: string,
  columns: readonly string[],
  rows: Row[],
): void {
  writeFileSync(path, formatCsv(columns, rows));
}

/** The `evidence` and `spans` cells for gold spans. */
export function evidenceCells(spans: GoldSpan[]): {
  evidence: string;
  spans: string;
} {
  return {
    evidence: spans
      .map(
        (s) =>
          `${s.doc_id}: ${docText(s.doc_id).slice(s.char_start, s.char_end)}`,
      )
      .join(SEP),
    spans: spans
      .map((s) => `${s.doc_id}:${s.char_start}-${s.char_end}`)
      .join(SEP),
  };
}

const list = (cell: string | undefined) =>
  (cell ?? "").split(/[\s,;]+/).filter(Boolean);

function parseBool(cell: string, fallback: boolean): boolean {
  const v = cell.trim().toLowerCase();
  if (v === "") return fallback;
  if (["yes", "y", "true", "1"].includes(v)) return true;
  if (["no", "n", "false", "0"].includes(v)) return false;
  throw new Error(`answerable must be yes or no, got "${cell}"`);
}

function anchor(entry: string, hint: string | undefined): GoldSpan {
  const m = DOC_ID.exec(entry.trim());
  if (!m)
    throw new Error(
      `evidence entry must look like "DOC_ID: quote": ${entry.slice(0, 60)}`,
    );
  const [, docId = "", quote = ""] = m;
  let text: string;
  try {
    text = docText(docId);
  } catch {
    throw new Error(`unknown doc ${docId} (run pnpm data:chunk?)`);
  }
  const h = hint ? HINT.exec(hint.trim()) : null;
  if (h && h[1] === docId) {
    const [start, end] = [Number(h[2]), Number(h[3])];
    const same = locate(text.slice(start, end), quote);
    if (same && same.char_start === 0 && same.char_end === end - start) {
      return { doc_id: docId, char_start: start, char_end: end };
    }
  }
  const hit = locate(text, quote, {
    key: docId,
    near: h && h[1] === docId ? Number(h[2]) : undefined,
  });
  if (!hit) {
    throw new Error(
      `quote not found in ${docId}, or found more than once (quote a longer passage): "${quote.slice(0, 80)}"`,
    );
  }
  return { doc_id: docId, ...hit };
}

/** A reviewed CSV row as a gold item (without split). Throws on invalid rows. */
export function rowToItem(row: Row, source: Source): Omit<GoldItem, "split"> {
  const id = (row.id ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) throw new Error(`bad id "${id}"`);
  const category = (row.category ?? "").trim() as Category;
  if (!CATEGORIES.includes(category)) {
    throw new Error(`category must be one of ${CATEGORIES.join(", ")}`);
  }
  const question = (row.question ?? "").trim();
  const gold_answer = (row.gold_answer ?? "").trim();
  if (!question || !gold_answer)
    throw new Error("question and gold_answer are required");
  const answerable = parseBool(
    row.answerable ?? "",
    category !== "unanswerable",
  );
  if (category === "unanswerable" && answerable) {
    throw new Error("unanswerable items need answerable = no");
  }
  const hints = (row.spans ?? "").split(SEP);
  const gold_spans = (row.evidence ?? "")
    .split(SEP)
    .filter((e) => e.trim())
    .map((e, i) => anchor(e, hints[i]));
  if (answerable && gold_spans.length === 0) {
    throw new Error("answerable items need at least one evidence quote");
  }
  const docs = gold_spans.map((s) => s.doc_id);
  const companies = list(row.companies).map((c) => c.toUpperCase());
  const years = list(row.fiscal_years).map((y) =>
    Number(y.replace(/^FY/i, "")),
  );
  if (years.some((y) => !Number.isInteger(y))) {
    throw new Error(`bad fiscal_years "${row.fiscal_years}"`);
  }
  const item: Omit<GoldItem, "split"> = {
    id,
    question,
    category,
    companies: companies.length
      ? [...new Set(companies)].sort()
      : [...new Set(docs.map((d) => d.split("-FY")[0] as string))].sort(),
    fiscal_years: years.length
      ? [...new Set(years)].sort()
      : [...new Set(docs.map((d) => Number(d.split("-FY")[1])))].sort(),
    answerable,
    gold_answer,
    gold_spans,
    source,
  };
  const value = (row.gold_value ?? "").replace(/[,$\s]/g, "");
  if (value) {
    const tolerance = Number(row.gold_tolerance || 0);
    if (!Number.isFinite(Number(value)) || !Number.isFinite(tolerance)) {
      throw new Error("gold_value and gold_tolerance must be numbers");
    }
    item.gold_numeric = {
      value: Number(value),
      unit: (row.gold_unit ?? "").trim() || "USD",
      tolerance,
    };
  }
  return item;
}

export function isDecision(v: string): v is (typeof DECISIONS)[number] {
  return (DECISIONS as readonly string[]).includes(v);
}
