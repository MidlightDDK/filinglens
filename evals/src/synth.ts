// `pnpm eval:synth [--limit N] [--dry-run]`: an LLM proposes eval items from
// sampled structure chunks → new rows in evals/review/queue.csv for human
// review (accept / edit / reject), then `pnpm eval:import`. Existing rows and
// their decisions are never touched. Needs GROQ_API_KEY for uncached calls.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type Docs, loadIndex, searchDense } from "@filinglens/core";
import { fsIndexSource, REPO_ROOT } from "@filinglens/core/node";
import type { Row } from "./csv.ts";
import {
  type Category,
  docText,
  type GoldSpan,
  locate,
  sha256,
} from "./dataset.ts";
import { type ChatRequest, LlmClient, PROVIDERS } from "./llm.ts";
import {
  evidenceCells,
  QUEUE_COLUMNS,
  QUEUE_PATH,
  readCsv,
  writeCsv,
} from "./review.ts";

const MODEL = "openai/gpt-oss-120b"; // https://console.groq.com/docs/models
const SEED = "synth-v1";
const STRATEGY = "structure";
// Proposals per category; reviewers typically reject some. XBRL items cover
// table_number and trend, and add to comparison and multi_hop.
const PLAN: [Category, number][] = [
  ["lookup", 40],
  ["false_premise", 22],
  ["unanswerable", 22],
  ["multi_hop", 16],
  ["comparison", 12],
];

interface Chunk {
  chunk_id: string;
  doc_id: string;
  item: string;
  heading_path: string[];
  char_start: number;
  char_end: number;
  n_tokens: number;
}

const TASKS: Record<Category, string> = {
  lookup:
    "Write one factual question answered by a specific statement in P1: a fact, name, date, policy, or a figure stated in prose (not a value read off a table).",
  false_premise:
    "Write one question built on a false premise that P1 directly contradicts, e.g. it asks why something declined when P1 says it grew, or assumes a product, segment, or event that P1 describes differently. The answer points out the false premise and states what P1 actually says. Quote the contradicting evidence.",
  unanswerable:
    "Write one question on the topic of P1 that sounds answerable from a 10-K but is not: it asks for a specific detail P1 does not give and annual reports do not disclose (e.g. a named customer's contract terms, next quarter's results, internal targets, or a breakdown the filing does not provide). The answer says what the filing does not disclose. Return \"evidence\": [].",
  multi_hop:
    "Write one question that needs a fact from P1 AND a fact from P2 (the same filing) to answer, e.g. a described strategy and its reported result. Quote evidence from both passages.",
  comparison:
    "Write one question comparing the two companies on a point that both P1 and P2 address. The answer states each company's position. Quote evidence from both passages.",
  table_number: "",
  trend: "",
};

const RULES = `Rules:
- Ask the way an analyst would, without having seen the passages: name the company (or both companies) and the fiscal year, e.g. "in fiscal year 2025". Never mention "the passage" or "the excerpt".
- Evidence quotes are copied verbatim from the passages: whole sentences or table rows, 40 to 300 characters each.
- The answer is 1 or 2 sentences, uses only the passages, and keeps numbers and units exactly as written.
- If the passages are boilerplate, a table of contents, or too thin for the task, return {"skip": true}.
Return only JSON: {"question": string, "answer": string, "evidence": [{"passage": "P1", "quote": string}], "skip": false}`;

function loadChunks(): Chunk[] {
  return readFileSync(
    `${REPO_ROOT}data/processed/chunks/${STRATEGY}.jsonl`,
    "utf8",
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const { text: _text, ...c } = JSON.parse(line) as Chunk & {
        text: string;
      };
      return c;
    });
}

const body = (c: Chunk) => docText(c.doc_id).slice(c.char_start, c.char_end);

/** Mostly prose: tables are covered by the XBRL items. */
function isProse(c: Chunk): boolean {
  const lines = body(c)
    .split("\n")
    .filter((l) => l.trim());
  return lines.filter((l) => l.startsWith("|")).length <= lines.length * 0.3;
}

function passage(label: string, c: Chunk, docs: Docs): string {
  const d = docs[c.doc_id];
  const where = [`Item ${c.item}`, ...c.heading_path.slice(1)].join(" > ");
  return `[${label}] ${d?.company ?? c.doc_id} FY${d?.fy ?? ""} 10-K, ${where}\n${body(c)}`;
}

interface Proposal {
  question?: string;
  answer?: string;
  evidence?: { passage?: string; quote?: string }[];
  skip?: boolean;
}

function parseJson(content: string): Proposal | null {
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Proposal;
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const { values: args } = parseArgs({
    options: {
      limit: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const limit = args.limit ? Number(args.limit) : Number.POSITIVE_INFINITY;

  const index = await loadIndex(fsIndexSource(), STRATEGY);
  const rowOf = new Map(index.rows.chunk_ids.map((id, i) => [id, i]));
  const chunks = loadChunks().filter(
    (c) => c.n_tokens >= 120 && rowOf.has(c.chunk_id) && isProse(c),
  );
  const byId = new Map(chunks.map((c) => [c.chunk_id, c]));

  // Hash order, round-robin over docs, so every filing contributes.
  const perDoc = new Map<string, Chunk[]>();
  for (const c of [...chunks].sort((a, b) =>
    sha256(`${SEED}|${a.chunk_id}`) < sha256(`${SEED}|${b.chunk_id}`) ? -1 : 1,
  )) {
    perDoc.set(c.doc_id, [...(perDoc.get(c.doc_id) ?? []), c]);
  }
  const lanes = [...perDoc.keys()].sort().map((d) => perDoc.get(d) ?? []);
  const order: Chunk[] = [];
  for (let i = 0; order.length < chunks.length; i++) {
    for (const lane of lanes) if (lane[i]) order.push(lane[i] as Chunk);
  }

  /** The most similar prose chunk among rows allowed by `ok` (dense cosine). */
  const partner = (c: Chunk, ok: (o: Chunk) => boolean): Chunk | null => {
    const row = rowOf.get(c.chunk_id) as number;
    const { dim } = index.meta;
    const scale = index.scales[row] as number;
    const q = Float32Array.from(
      index.vectors.subarray(row * dim, (row + 1) * dim),
      (v) => v * scale,
    );
    const allowed = Uint8Array.from(index.rows.chunk_ids, (id) => {
      const o = byId.get(id);
      return o && ok(o) ? 1 : 0;
    });
    const [hit] = searchDense(index.vectors, index.scales, dim, q, allowed, 1);
    return hit ? (byId.get(index.rows.chunk_ids[hit.row] ?? "") ?? null) : null;
  };

  const fy = (c: Chunk) => index.docs[c.doc_id]?.fy;
  const ticker = (c: Chunk) => index.docs[c.doc_id]?.ticker;
  const tasks: { category: Category; passages: Chunk[] }[] = [];
  let next = 0;
  for (const [category, n] of PLAN) {
    for (let k = 0; k < n && next < order.length; next++) {
      const c = order[next] as Chunk;
      const passages: (Chunk | null)[] = [c];
      if (category === "multi_hop") {
        passages.push(
          partner(c, (o) => o.doc_id === c.doc_id && o.item !== c.item),
        );
      } else if (category === "comparison") {
        passages.push(
          partner(
            c,
            (o) =>
              ticker(o) !== ticker(c) && fy(o) === fy(c) && o.item === c.item,
          ),
        );
      }
      if (passages.some((p) => !p)) continue;
      tasks.push({ category, passages: passages as Chunk[] });
      k++;
    }
  }

  const existing = readCsv(QUEUE_PATH);
  const known = new Set(existing.map((r) => r.id));
  let llm: LlmClient | null = null;
  const added: Row[] = [];
  const skipped: Record<string, number> = {};
  const bump = (why: string) => {
    skipped[why] = (skipped[why] ?? 0) + 1;
  };
  let calls = 0;
  for (const t of tasks) {
    const id = `syn-${t.category.replace("_", "-")}-${sha256(t.passages.map((p) => p.chunk_id).join("|")).slice(0, 8)}`;
    if (known.has(id)) continue;
    if (calls >= limit) break;
    const labels = t.passages.map((_, i) => `P${i + 1}`);
    const req: ChatRequest = {
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            "You write evaluation questions for a question-answering system over SEC 10-K annual reports.",
        },
        {
          role: "user",
          content: `${TASKS[t.category]}\n\n${RULES}\n\n${t.passages.map((p, i) => passage(labels[i] as string, p, index.docs)).join("\n\n")}`,
        },
      ],
      temperature: 0.4,
      max_tokens: 1200,
      reasoning_effort: "low",
      response_format: { type: "json_object" },
    };
    if (args["dry-run"]) {
      console.log(`--- ${id}\n${req.messages[1]?.content}\n`);
      calls++;
      continue;
    }
    llm ??= new LlmClient(PROVIDERS.groq);
    const res = await llm.chat(req);
    calls++;
    const p = parseJson(res.content);
    if (!p) {
      bump("invalid JSON");
      continue;
    }
    if (p.skip || !p.question || !p.answer) {
      bump("model skipped");
      continue;
    }
    const spans: GoldSpan[] = [];
    let bad = false;
    for (const e of p.evidence ?? []) {
      const c = t.passages[labels.indexOf(e.passage ?? "")];
      const hit = c && e.quote ? locate(body(c), e.quote) : null;
      if (!c || !hit || hit.char_end - hit.char_start < 30) {
        bad = true;
        continue;
      }
      spans.push({
        doc_id: c.doc_id,
        char_start: c.char_start + hit.char_start,
        char_end: c.char_start + hit.char_end,
      });
    }
    // Answerable items need verbatim evidence from every passage.
    const needed = t.category === "unanswerable" ? 0 : t.passages.length;
    const from = new Set(spans.map((s) => passageOf(s, t.passages)));
    if (needed > 0 && (bad || from.size < needed)) {
      bump("evidence not verbatim or incomplete");
      continue;
    }
    const cells = evidenceCells(needed > 0 ? spans : []);
    added.push({
      id,
      decision: "",
      category: t.category,
      question: p.question.trim(),
      gold_answer: p.answer.trim(),
      answerable: t.category === "unanswerable" ? "no" : "yes",
      companies: [...new Set(t.passages.map(ticker))].sort().join(" "),
      fiscal_years: [...new Set(t.passages.map(fy))].sort().join(" "),
      evidence: cells.evidence,
      spans: cells.spans,
      context: t.passages
        .map((c, i) =>
          passage(labels[i] as string, c, index.docs).slice(0, 1500),
        )
        .join("\n\n"),
    });
  }
  if (args["dry-run"]) return 0;

  const sortKey = (r: Row) => `${r.category} ${r.id}`;
  added.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
  writeCsv(QUEUE_PATH, QUEUE_COLUMNS, [...existing, ...added]);
  console.log(
    `Added ${added.length} rows to evals/review/queue.csv (${existing.length} kept)`,
  );
  for (const [why, n] of Object.entries(skipped))
    console.log(`  dropped ${n}: ${why}`);
  return 0;
}

/** Which passage (by index) a span came from. */
function passageOf(s: GoldSpan, passages: Chunk[]): number {
  return passages.findIndex(
    (p) =>
      p.doc_id === s.doc_id &&
      s.char_start >= p.char_start &&
      s.char_end <= p.char_end,
  );
}

if (import.meta.main) process.exitCode = await main();
