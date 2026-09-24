// `pnpm eval:import`: XBRL items + accepted/edited rows of evals/review/queue.csv
// + evals/review/handwritten.csv → evals/datasets/golden.jsonl. Splits are
// stable: an item keeps its split forever; new items fill each category toward
// 60% dev / 40% test in sha256(id) order.
import { writeFileSync } from "node:fs";
import {
  CATEGORIES,
  docText,
  GOLDEN_PATH,
  type GoldItem,
  readJsonl,
  type Split,
  sha256,
  TEXT_HASHES_PATH,
  writeJsonl,
  XBRL_PATH,
} from "./dataset.ts";
import {
  HANDWRITTEN_PATH,
  isDecision,
  QUEUE_PATH,
  readCsv,
  rowToItem,
} from "./review.ts";

const DEV_SHARE = 0.6;

type Unsplit = Omit<GoldItem, "split">;

export function assignSplits(
  items: Unsplit[],
  previous: Map<string, Split>,
): GoldItem[] {
  const out: GoldItem[] = [];
  const byCategory = new Map<string, Unsplit[]>();
  for (const it of items) {
    byCategory.set(it.category, [...(byCategory.get(it.category) ?? []), it]);
  }
  for (const group of byCategory.values()) {
    let dev = 0;
    let test = 0;
    const fresh: Unsplit[] = [];
    for (const it of group) {
      const split = previous.get(it.id);
      if (split) {
        out.push({ ...it, split });
        if (split === "dev") dev++;
        else test++;
      } else {
        fresh.push(it);
      }
    }
    fresh.sort((a, b) => (sha256(a.id) < sha256(b.id) ? -1 : 1));
    for (const it of fresh) {
      const split: Split =
        dev < Math.round(DEV_SHARE * (dev + test + 1)) ? "dev" : "test";
      out.push({ ...it, split });
      if (split === "dev") dev++;
      else test++;
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

function main(): number {
  const errors: string[] = [];
  const items: Unsplit[] = readJsonl<Unsplit>(XBRL_PATH);

  const pending: string[] = [];
  for (const row of readCsv(QUEUE_PATH)) {
    const decision = (row.decision ?? "").trim().toLowerCase();
    if (!decision) {
      pending.push(row.id ?? "");
      continue;
    }
    if (!isDecision(decision)) {
      errors.push(
        `queue.csv ${row.id}: decision must be accept, edit, or reject`,
      );
      continue;
    }
    if (decision === "reject") continue;
    try {
      items.push(rowToItem(row, "synthetic_reviewed"));
    } catch (e) {
      errors.push(`queue.csv ${row.id}: ${(e as Error).message}`);
    }
  }
  for (const row of readCsv(HANDWRITTEN_PATH)) {
    if (!row.question?.trim() || row.id?.startsWith("example")) continue;
    try {
      items.push(rowToItem(row, "handwritten"));
    } catch (e) {
      errors.push(`handwritten.csv ${row.id}: ${(e as Error).message}`);
    }
  }
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.id)) errors.push(`duplicate id ${it.id}`);
    seen.add(it.id);
  }
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    console.error(`\n${errors.length} errors; golden.jsonl not written`);
    return 1;
  }

  const previous = new Map(
    readJsonl<GoldItem>(GOLDEN_PATH).map((it) => [it.id, it.split]),
  );
  const golden = assignSplits(items, previous);
  writeJsonl(GOLDEN_PATH, golden);

  // Gold spans are offsets into these texts; the runner checks they still match.
  const docs = [
    ...new Set(golden.flatMap((it) => it.gold_spans.map((s) => s.doc_id))),
  ].sort();
  writeFileSync(
    TEXT_HASHES_PATH,
    `${JSON.stringify(Object.fromEntries(docs.map((d) => [d, sha256(docText(d))])), null, 2)}\n`,
  );

  console.log(`Wrote ${golden.length} items to evals/datasets/golden.jsonl`);
  console.log(
    `\n${"category".padEnd(15)}${"dev".padStart(5)}${"test".padStart(6)}  sources`,
  );
  for (const c of CATEGORIES) {
    const inCat = golden.filter((it) => it.category === c);
    const sources = [...new Set(inCat.map((it) => it.source))]
      .map((s) => `${s} ${inCat.filter((it) => it.source === s).length}`)
      .join(", ");
    const n = (s: Split) => inCat.filter((it) => it.split === s).length;
    console.log(
      `${c.padEnd(15)}${String(n("dev")).padStart(5)}${String(n("test")).padStart(6)}  ${sources}`,
    );
  }
  if (pending.length > 0) {
    console.log(
      `\n${pending.length} queue rows still need a decision (accept, edit, reject)`,
    );
  }
  return 0;
}

if (import.meta.main) process.exitCode = main();
