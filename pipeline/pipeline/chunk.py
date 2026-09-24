"""Parse every filing in the manifest, chunk it (`fixed`, `structure`), print stats.

Usage: python -m pipeline.chunk   (offline; run `pnpm data:ingest` first)
"""

from __future__ import annotations

import json
import logging
import re
import statistics
import sys
from bisect import bisect_right
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path

from pipeline.config import MANIFEST_PATH, PROCESSED_DIR, RAW_DIR, load_corpus
from pipeline.ingest import load_manifest
from pipeline.parse import Block, ParsedDoc, parse_filing, write_parsed
from pipeline.tokenizer import TokenCounter, load_tokenizer

log = logging.getLogger("pipeline.chunk")

FIXED_TOKENS, FIXED_OVERLAP = 350, 50
STRUCT_TOKENS, TABLE_TOKENS = 350, 600
_SENTENCE_END = re.compile(r"(?<=[.!?])[\"')\]]?\s+(?=[\"'(\[]?[A-Z0-9$])")


@dataclass
class Chunk:
    chunk_id: str
    doc_id: str
    strategy: str
    item: str
    heading_path: list[str]
    char_start: int
    char_end: int
    n_tokens: int
    text: str


def _block_at(doc: ParsedDoc, starts: list[int], pos: int) -> Block:
    return doc.blocks[max(bisect_right(starts, pos) - 1, 0)]


def fixed_chunks(
    doc: ParsedDoc,
    tok: TokenCounter,
    size: int = FIXED_TOKENS,
    overlap: int = FIXED_OVERLAP,
) -> list[Chunk]:
    """Structure-blind baseline: token windows over the whole doc text."""
    offs = tok.offsets(doc.text)
    starts = [b.char_start for b in doc.blocks]
    chunks: list[Chunk] = []
    for i in range(0, len(offs), size - overlap):
        window = offs[i : i + size]
        s, e = window[0][0], window[-1][1]
        text = doc.text[s:e]
        blk = _block_at(doc, starts, s)
        cid = f"{doc.doc_id}-fixed-{len(chunks):05d}"
        chunks.append(
            Chunk(
                cid,
                doc.doc_id,
                "fixed",
                blk.item,
                blk.heading_path,
                s,
                e,
                tok.count(text),
                text,
            )
        )
        if i + size >= len(offs):
            break
    return chunks


def _split_long(
    doc: ParsedDoc, s: int, e: int, tok: TokenCounter, budget: int
) -> list[tuple[int, int, int]]:
    """Split [s, e) into (start, end, n_tokens) pieces of <= budget tokens:
    sentences, then token windows."""
    pieces: list[tuple[int, int, int]] = []
    cuts = [s] + [s + m.end() for m in _SENTENCE_END.finditer(doc.text[s:e])] + [e]
    for a, b in zip(cuts, cuts[1:], strict=False):
        sent = doc.text[a:b].rstrip()
        n = tok.count(sent)
        if n <= budget:
            pieces.append((a, a + len(sent), n))
            continue
        offs = tok.offsets(sent)
        for i in range(0, len(offs), budget):
            w = offs[i : i + budget]
            pieces.append((a + w[0][0], a + w[-1][1], len(w)))
    # Greedily re-pack sentences up to the budget.
    packed: list[tuple[int, int, int]] = []
    for a, b, n in pieces:
        if packed and packed[-1][2] + n <= budget:
            pa, _, pn = packed[-1]
            packed[-1] = (pa, b, pn + n)
        else:
            packed.append((a, b, n))
    return packed


def structure_chunks(
    doc: ParsedDoc,
    tok: TokenCounter,
    company: str,
    fy: int,
    max_tokens: int = STRUCT_TOKENS,
    table_tokens: int = TABLE_TOKENS,
) -> list[Chunk]:
    """Split at headings; pack paragraphs up to max_tokens; tables whole up to
    table_tokens, else by row groups with the header repeated. Every chunk starts
    with a context prefix."""
    chunks: list[Chunk] = []

    def emit(
        item: str, path: list[str], prefix: str, s: int, e: int, body: str | None = None
    ) -> None:
        text = f"{prefix}\n\n{body if body is not None else doc.text[s:e]}"
        cid = f"{doc.doc_id}-structure-{len(chunks):05d}"
        chunks.append(
            Chunk(cid, doc.doc_id, "structure", item, path, s, e, tok.count(text), text)
        )

    group: list[Block] = []

    def flush_group() -> None:
        if not group:
            return
        item, path = group[0].item, group[0].heading_path
        prefix = f"{company} FY{fy} 10-K | {path[0]}" + (
            f" | {path[-1]}" if len(path) > 1 else ""
        )
        budget = max_tokens - tok.count(prefix)
        run: list[tuple[int, int, int]] = []  # packed paragraph pieces awaiting emit

        def flush_run() -> None:
            if run:
                emit(item, path, prefix, run[0][0], run[-1][1])
                run.clear()

        for b in group:
            if b.type == "table":
                flush_run()
                _table_chunks(
                    doc,
                    b,
                    tok,
                    prefix,
                    table_tokens,
                    lambda s, e, body: emit(item, path, prefix, s, e, body),
                )
                continue
            n = tok.count(doc.text[b.char_start : b.char_end])
            pieces = (
                [(b.char_start, b.char_end, n)]
                if n <= budget
                else _split_long(doc, b.char_start, b.char_end, tok, budget)
            )
            for piece in pieces:
                if run and sum(p[2] for p in run) + piece[2] > budget:
                    flush_run()
                run.append(piece)
        flush_run()
        group.clear()

    for b in doc.blocks:
        if b.type == "heading" or (
            group and (b.item, b.heading_path) != (group[0].item, group[0].heading_path)
        ):
            flush_group()
        if b.type != "heading":
            group.append(b)
    flush_group()
    return chunks


def _table_chunks(
    doc: ParsedDoc,
    b: Block,
    tok: TokenCounter,
    prefix: str,
    limit: int,
    emit: Callable[[int, int, str | None], None],
) -> None:
    text = doc.text[b.char_start : b.char_end]
    if tok.count(f"{prefix}\n\n{text}") <= limit:
        emit(b.char_start, b.char_end, None)
        return
    lines = text.split("\n")
    sep = next((i for i, ln in enumerate(lines) if ln.startswith("| ---")), 0)
    header = "\n".join(lines[: sep + 1])
    budget = limit - tok.count(f"{prefix}\n\n{header}")
    pos = b.char_start + len(header) + 1
    group: list[tuple[int, int, int]] = []

    def flush() -> None:
        if group:
            s, e = group[0][0], group[-1][1]
            emit(s, e, f"{header}\n{doc.text[s:e]}")
            group.clear()

    for ln in lines[sep + 1 :]:
        n = tok.count(ln)
        if group and sum(g[2] for g in group) + n > budget:
            flush()
        group.append((pos, pos + len(ln), n))
        pos += len(ln) + 1
    flush()


# ---------------------------------------------------------------- driver and stats


def _pct(xs: list[int], q: float) -> int:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, round(q * (len(xs) - 1)))] if xs else 0


def _table_share(chunks: list[Chunk], docs: dict[str, ParsedDoc]) -> float:
    """Share of chunks whose characters lie mostly inside table blocks."""
    n_table = 0
    for c in chunks:
        inside = sum(
            max(0, min(c.char_end, b.char_end) - max(c.char_start, b.char_start))
            for b in docs[c.doc_id].blocks
            if b.type == "table"
            and b.char_start < c.char_end
            and b.char_end > c.char_start
        )
        n_table += inside * 2 > c.char_end - c.char_start
    return n_table / len(chunks) if chunks else 0.0


def parse_corpus(
    keep_items: list[str],
) -> tuple[list[tuple[ParsedDoc, str, int]], list[str]]:
    corpus = load_corpus()
    docs, failures = [], []
    for m in load_manifest():
        try:
            html = (RAW_DIR / m.path).read_bytes()
            company = corpus.company(m.ticker)
            doc = parse_filing(html, m.doc_id, keep_items, company.sections)
            write_parsed(doc, PROCESSED_DIR)
            docs.append((doc, m.company, m.fy))
            for w in doc.warnings:
                log.warning("%s: %s", m.doc_id, w)
        except Exception as e:  # log every failure with its reason and continue
            failures.append(f"{m.doc_id}: {type(e).__name__}: {e}")
    return docs, failures


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if not MANIFEST_PATH.exists():
        log.error("%s not found; run `pnpm data:ingest` first", MANIFEST_PATH)
        return 2
    keep = load_corpus().items
    tok = load_tokenizer()
    parsed, failures = parse_corpus(keep)
    docs = {d.doc_id: d for d, _, _ in parsed}

    by_strategy: dict[str, list[Chunk]] = {"fixed": [], "structure": []}
    for doc, company, fy in parsed:
        by_strategy["fixed"] += fixed_chunks(doc, tok)
        by_strategy["structure"] += structure_chunks(doc, tok, company, fy)
    out_dir: Path = PROCESSED_DIR / "chunks"
    out_dir.mkdir(parents=True, exist_ok=True)
    for strategy, chunks in by_strategy.items():
        with (out_dir / f"{strategy}.jsonl").open(
            "w", encoding="utf-8", newline="\n"
        ) as f:
            for c in chunks:
                f.write(json.dumps(asdict(c), ensure_ascii=False) + "\n")

    n = len(parsed)
    coverage = {item: sum(item in d.items for d in docs.values()) for item in keep}
    all_items = sum(all(i in d.items for i in keep) for d in docs.values())
    stats = {
        "docs_parsed": n,
        "failures": failures,
        "item_coverage": {i: c / n if n else 0 for i, c in coverage.items()},
        "all_items_coverage": all_items / n if n else 0,
        "warnings": {d.doc_id: d.warnings for d in docs.values() if d.warnings},
        "strategies": {},
    }
    print(f"\nParsed {n} docs, {len(failures)} failures")
    print(
        "Item coverage: "
        + "  ".join(f"{i} {c}/{n}" for i, c in coverage.items())
        + f"  | all five {all_items}/{n}"
    )
    print(f"\n{'doc_id':<14}{'chars':>9}  " + "  ".join(f"{s:>9}" for s in by_strategy))
    per_doc = {s: {} for s in by_strategy}
    for s, chunks in by_strategy.items():
        for c in chunks:
            per_doc[s][c.doc_id] = per_doc[s].get(c.doc_id, 0) + 1
    for doc_id, d in docs.items():
        print(
            f"{doc_id:<14}{len(d.text):>9}  "
            + "  ".join(f"{per_doc[s].get(doc_id, 0):>9}" for s in by_strategy)
        )
    print(
        f"\n{'strategy':<11}{'chunks':>7}{'per doc':>9}"
        f"{'tok p50':>9}{'tok p95':>9}{'tok max':>9}{'% table':>9}"
    )
    for s, chunks in by_strategy.items():
        toks = [c.n_tokens for c in chunks]
        row = {
            "chunks": len(chunks),
            "chunks_per_doc_median": statistics.median(per_doc[s].values())
            if per_doc[s]
            else 0,
            "tokens_p50": _pct(toks, 0.5),
            "tokens_p95": _pct(toks, 0.95),
            "tokens_max": max(toks, default=0),
            "table_chunk_share": _table_share(chunks, docs),
        }
        stats["strategies"][s] = row
        print(
            f"{s:<11}{row['chunks']:>7}{row['chunks_per_doc_median']:>9}{row['tokens_p50']:>9}"
            f"{row['tokens_p95']:>9}{row['tokens_max']:>9}{row['table_chunk_share']:>9.1%}"
        )
    (PROCESSED_DIR / "stats.json").write_text(
        json.dumps(stats, indent=2) + "\n", encoding="utf-8"
    )
    for f in failures:
        log.error("FAILED %s", f)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
