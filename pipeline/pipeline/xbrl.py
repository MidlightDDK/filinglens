"""XBRL company facts → evals/datasets/xbrl_numeric.jsonl (numeric eval items).

Usage: python -m pipeline.xbrl [--refresh]   (needs SEC_USER_AGENT to download)
Reads data/raw/manifest.json and data/processed/text/; caches company facts in
data/raw/xbrl/. Output is deterministic (stable ids, hash-ordered sampling).
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import logging
import re
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

from pipeline.config import PROCESSED_DIR, RAW_DIR, REPO_ROOT, load_corpus
from pipeline.ingest import ManifestEntry, load_manifest
from pipeline.sec import SecClient, SecError

log = logging.getLogger("pipeline.xbrl")

FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json"
OUT_PATH = REPO_ROOT / "evals" / "datasets" / "xbrl_numeric.jsonl"

# Items per template. Candidates are sampled in sha256(id) order, round-robin
# over companies (or concepts, for comparisons) so no company dominates.
TARGETS = {"table_number": 36, "trend": 24, "multi_hop": 24, "comparison": 24}
MAX_SPANS_PER_GROUP = 8
MIN_SPAN_CHARS = 30  # a chunk is relevant if it overlaps a gold span by >= 30 chars
PCT_TOLERANCE = 0.5  # percentage points
USD_TOLERANCE = 0.005  # relative, converted to an absolute tolerance per item
EPS_TOLERANCE = 0.005  # dollars per share


@dataclass(frozen=True)
class Concept:
    key: str
    tags: tuple[str, ...]  # us-gaap concepts, in order of preference
    unit: str  # companyfacts unit key
    duration: bool  # flow (income statement) vs instant (balance sheet)
    label: str  # as used in questions
    keywords: str  # regex; a matched row label or sentence must contain it


CONCEPTS = {
    c.key: c
    for c in [
        Concept(
            "revenue",
            ("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax"),
            "USD",
            True,
            "total revenue",
            r"revenue|net sales|total sales",
        ),
        Concept(
            "net_income",
            ("NetIncomeLoss",),
            "USD",
            True,
            "net income",
            r"net (income|earnings|loss)",
        ),
        Concept(
            "rd",
            ("ResearchAndDevelopmentExpense",),
            "USD",
            True,
            "research and development expense",
            r"research and development|\bR&D\b|technology and development",  # NFLX
        ),
        Concept(
            "operating_income",
            ("OperatingIncomeLoss",),
            "USD",
            True,
            "operating income",
            r"operating (income|loss|profit)|income from operations",
        ),
        Concept(
            "eps_diluted",
            ("EarningsPerShareDiluted",),
            "USD/shares",
            True,
            "diluted earnings per share",
            r"diluted",
        ),
        Concept(
            "cash",
            ("CashAndCashEquivalentsAtCarryingValue",),
            "USD",
            False,
            "cash and cash equivalents",
            r"cash and cash equivalents",
        ),
    ]
}

PCT_OF_REVENUE = "as a percentage of total revenue"
RATIOS = [  # (numerator, denominator, question phrase)
    ("rd", "revenue", f"research and development expense {PCT_OF_REVENUE}"),
    ("net_income", "revenue", f"net profit margin (net income {PCT_OF_REVENUE})"),
    (
        "operating_income",
        "revenue",
        f"operating margin (operating income {PCT_OF_REVENUE})",
    ),
]

# Two-company comparisons stay within a sector.
PAIRS = [
    ("NVDA", "AMD"),
    ("NVDA", "INTC"),
    ("AMD", "INTC"),
    ("AAPL", "MSFT"),
    ("MSFT", "GOOGL"),
    ("GOOGL", "META"),
    ("AMZN", "GOOGL"),
    ("META", "NFLX"),
    ("KO", "PEP"),
    ("AAPL", "AMZN"),
]


@dataclass(frozen=True)
class FyValues:
    current: float
    prior: float | None  # the comparative for the prior fiscal year, same filing


def _days(start: str, end: str) -> int:
    return (date.fromisoformat(end) - date.fromisoformat(start)).days


def fy_values(
    facts: dict[str, Any], concept: Concept, accession: str, report_date: str
) -> FyValues | None:
    """The filing's own fiscal-year value (period ending on `report_date`) and its
    prior-year comparative, both from the same 10-K. Values from other filings,
    quarters, and comparative columns never count as the current year."""
    gaap = facts.get("facts", {}).get("us-gaap", {})
    for tag in concept.tags:
        rows = gaap.get(tag, {}).get("units", {}).get(concept.unit, [])
        current: set[float] = set()
        prior: set[float] = set()
        for r in rows:
            if r.get("accn") != accession or r.get("form") != "10-K":
                continue
            if r.get("fp") != "FY":
                continue
            if concept.duration and not (
                "start" in r and 350 <= _days(r["start"], r["end"]) <= 380
            ):
                continue
            if r["end"] == report_date:
                current.add(r["val"])
            elif 350 <= _days(r["end"], report_date) <= 380:
                prior.add(r["val"])
        if len(current) == 1:
            return FyValues(current.pop(), prior.pop() if len(prior) == 1 else None)
        if len(current) > 1:
            log.warning("%s %s: conflicting values %s", accession, tag, current)
            return None
    return None


# --- Finding gold spans in the doc text --------------------------------------


def value_formats(value: float, unit: str) -> list[str]:
    """Printed forms: tables in millions or thousands, prose in billions."""
    a = abs(value)
    if unit == "USD/shares":
        return [f"{a:.2f}"]
    out = []
    if a % 1_000_000 == 0:
        out.append(f"{a / 1e6:,.0f}")
    if a % 1_000 == 0:
        out.append(f"{a / 1e3:,.0f}")
    if a >= 1e9:
        out += [f"{a / 1e9:.1f} billion", f"{a / 1e9:.2f} billion"]
    return list(dict.fromkeys(out))


def _number_re(fmt: str) -> re.Pattern[str]:
    body = re.escape(fmt).replace(r"\ ", r"\s+")
    return re.compile(rf"(?<![\d.,]){body}(?!\d|[.,]\d)")


def _sentence(text: str, pos: int, lo: int, hi: int) -> tuple[int, int]:
    """Bounds of the sentence around `pos` inside the line [lo, hi)."""
    start = lo
    for m in re.finditer(r"[.!?]\s+(?=[A-Z(\"$])", text[lo:pos]):
        start = lo + m.end()
    m = re.search(r"[.!?](?=\s|$)", text[pos:hi])
    end = pos + m.end() if m else hi
    return start, end


def find_spans(text: str, value: float, concept: Concept) -> list[tuple[int, int]]:
    """Table rows whose label, or sentences that, mention the concept and contain
    the value in a common format. Spans are at least MIN_SPAN_CHARS long."""
    keywords = re.compile(concept.keywords, re.IGNORECASE)
    spans: set[tuple[int, int]] = set()
    for fmt in value_formats(value, concept.unit):
        for m in _number_re(fmt).finditer(text):
            lo = text.rfind("\n", 0, m.start()) + 1
            hi = text.find("\n", m.end())
            hi = len(text) if hi == -1 else hi
            line = text[lo:hi]
            if line.startswith("|"):
                cells = line.split("|")
                label = cells[1] if len(cells) > 1 else ""
                if keywords.search(label):
                    spans.add((lo, hi))
            else:
                s, e = _sentence(text, m.start(), lo, hi)
                if keywords.search(text[s:e]):
                    spans.add((s, e))
    out = []
    for s, e in sorted(spans):
        if e - s < MIN_SPAN_CHARS:
            pad = (MIN_SPAN_CHARS - (e - s) + 1) // 2
            s, e = max(0, s - pad), min(len(text), e + pad)
        out.append((s, e))
    return out[:MAX_SPANS_PER_GROUP]


# --- Items --------------------------------------------------------------------


@dataclass(frozen=True)
class Doc:
    entry: ManifestEntry
    name: str
    text: str
    values: dict[str, FyValues]


def fmt_usd(v: float) -> str:
    s = f"${abs(v) / 1e6:,.0f} million"
    if abs(v) >= 1e9:
        s += f" (${abs(v) / 1e9:.1f} billion)"
    return f"-{s}" if v < 0 else s


def fmt_value(v: float, concept: Concept) -> str:
    if concept.unit == "USD/shares":
        return f"-${abs(v):.2f}" if v < 0 else f"${v:.2f}"
    return fmt_usd(v)


def _numeric(v: float, concept: Concept) -> dict[str, Any]:
    if concept.unit == "USD/shares":
        return {"value": v, "unit": "USD/share", "tolerance": EPS_TOLERANCE}
    return {"value": v, "unit": "USD", "tolerance": round(abs(v) * USD_TOLERANCE)}


def _spans(
    docs: list[Doc], value: float, concept: Concept, group: str
) -> list[dict[str, Any]]:
    out = []
    for d in docs:
        for s, e in find_spans(d.text, value, concept):
            out.append(
                {
                    "doc_id": d.entry.doc_id,
                    "char_start": s,
                    "char_end": e,
                    "group": group,
                }
            )
    return out


def _item(
    id_: str, category: str, question: str, answer: str, docs: list[Doc], **extra: Any
) -> dict[str, Any]:
    return {
        "id": id_,
        "question": question,
        "category": category,
        "companies": sorted({d.entry.ticker for d in docs}),
        "fiscal_years": sorted({d.entry.fy for d in docs}),
        "answerable": True,
        "gold_answer": answer,
        **extra,
        "source": "xbrl",
    }


def value_items(doc: Doc) -> list[dict[str, Any]]:
    e, out = doc.entry, []
    for key, v in doc.values.items():
        c = CONCEPTS[key]
        if key == "cash":
            q = f"How much cash and cash equivalents did {doc.name} hold at the end of fiscal year {e.fy}?"  # noqa: E501
        else:
            q = f"What was {doc.name}'s {c.label} for fiscal year {e.fy}?"
        out.append(
            _item(
                f"xbrl-value-{e.ticker}-fy{e.fy}-{key}".lower(),
                "table_number",
                q,
                f"{doc.name}'s {c.label} for fiscal year {e.fy} was "
                f"{fmt_value(v.current, c)}.",
                [doc],
                gold_numeric=_numeric(v.current, c),
                gold_spans=_spans([doc], v.current, c, key),
            )
        )
    return out


def trend_items(doc: Doc, prior_doc: Doc | None) -> list[dict[str, Any]]:
    e, out = doc.entry, []
    for key, v in doc.values.items():
        c = CONCEPTS[key]
        if v.prior is None or v.prior <= 0 or v.current <= 0:
            continue
        pct = round((v.current - v.prior) / v.prior * 100, 1)
        verb = "rose" if pct > 0 else "fell"
        answer = (
            f"{doc.name}'s {c.label} {verb} {abs(pct)}%, from "
            f"{fmt_value(v.prior, c)} in fiscal year {e.fy - 1} to "
            f"{fmt_value(v.current, c)} in fiscal year {e.fy}."
        )
        span_docs = [doc] + ([prior_doc] if prior_doc else [])
        out.append(
            _item(
                f"xbrl-yoy-{e.ticker}-fy{e.fy}-{key}".lower(),
                "trend",
                f"How did {doc.name}'s {c.label} change from fiscal year {e.fy - 1} "
                f"to fiscal year {e.fy}?",
                answer,
                [doc],
                fiscal_years=[e.fy - 1, e.fy],
                gold_numeric={"value": pct, "unit": "%", "tolerance": PCT_TOLERANCE},
                gold_spans=_spans([doc], v.current, c, f"{key}_fy{e.fy}")
                + _spans(span_docs, v.prior, c, f"{key}_fy{e.fy - 1}"),
            )
        )
    return out


def ratio_items(doc: Doc) -> list[dict[str, Any]]:
    e, out = doc.entry, []
    for num, den, phrase in RATIOS:
        n, d = doc.values.get(num), doc.values.get(den)
        if not n or not d or d.current <= 0:
            continue
        pct = round(n.current / d.current * 100, 1)
        cn, cd = CONCEPTS[num], CONCEPTS[den]
        out.append(
            _item(
                f"xbrl-ratio-{e.ticker}-fy{e.fy}-{num}-{den}".lower(),
                "multi_hop",
                f"What was {doc.name}'s {phrase} for fiscal year {e.fy}?",
                f"{pct}%: {cn.label} of {fmt_value(n.current, cn)} divided by "
                f"{cd.label} of {fmt_value(d.current, cd)} in fiscal year {e.fy}.",
                [doc],
                gold_numeric={"value": pct, "unit": "%", "tolerance": PCT_TOLERANCE},
                gold_spans=_spans([doc], n.current, cn, num)
                + _spans([doc], d.current, cd, den),
            )
        )
    return out


def comparison_items(a: Doc, b: Doc) -> list[dict[str, Any]]:
    out = []
    fy = a.entry.fy
    for key in sorted(a.values.keys() & b.values.keys()):
        c = CONCEPTS[key]
        va, vb = a.values[key].current, b.values[key].current
        if va == vb:
            continue
        hi, lo = (a, b) if va > vb else (b, a)
        diff = abs(va - vb)
        numeric = _numeric(diff, c)
        if c.unit == "USD":
            numeric["tolerance"] = round(max(abs(va), abs(vb)) * USD_TOLERANCE)
        out.append(
            _item(
                f"xbrl-compare-{a.entry.ticker}-{b.entry.ticker}-fy{fy}-{key}".lower(),
                "comparison",
                f"Which company reported higher {c.label} for fiscal year {fy}, "
                f"{a.name} or {b.name}, and by how much?",
                f"{hi.name}: {fmt_value(hi.values[key].current, c)}; {lo.name}: "
                f"{fmt_value(lo.values[key].current, c)}. {hi.name}'s was higher by "
                f"{fmt_value(diff, c)}.",
                [a, b],
                gold_numeric=numeric,
                gold_spans=_spans([a], va, c, a.entry.ticker)
                + _spans([b], vb, c, b.entry.ticker),
            )
        )
    return out


def _hash(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def sample(items: list[dict[str, Any]], n: int, bucket: str) -> list[dict[str, Any]]:
    """Up to n items in sha256(id) order, round-robin over `bucket` values."""
    buckets: dict[str, list[dict[str, Any]]] = {}
    for it in sorted(items, key=lambda it: _hash(it["id"])):
        key = it["companies"][0] if bucket == "company" else it["id"].rsplit("-", 1)[1]
        buckets.setdefault(key, []).append(it)
    picked = [
        it
        for group in itertools.zip_longest(*(buckets[k] for k in sorted(buckets)))
        for it in group
        if it is not None
    ]
    return sorted(picked[:n], key=lambda it: it["id"])


def build_items(docs: list[Doc]) -> list[dict[str, Any]]:
    by_key = {(d.entry.ticker, d.entry.fy): d for d in docs}
    values, trends, ratios, comparisons = [], [], [], []
    for d in docs:
        values += value_items(d)
        trends += trend_items(d, by_key.get((d.entry.ticker, d.entry.fy - 1)))
        ratios += ratio_items(d)
    for ta, tb in PAIRS:
        for fy in sorted({d.entry.fy for d in docs}):
            a, b = by_key.get((ta, fy)), by_key.get((tb, fy))
            if a and b:
                comparisons += comparison_items(a, b)
    return (
        sample(values, TARGETS["table_number"], "company")
        + sample(trends, TARGETS["trend"], "company")
        + sample(ratios, TARGETS["multi_hop"], "company")
        + sample(comparisons, TARGETS["comparison"], "concept")
    )


def load_docs(client: SecClient | None, refresh: bool) -> list[Doc]:
    names = {c.ticker: c.name for c in load_corpus().companies}
    facts: dict[int, dict[str, Any]] = {}
    docs = []
    for e in sorted(load_manifest(), key=lambda e: e.doc_id):
        if e.cik not in facts:
            path = RAW_DIR / "xbrl" / f"CIK{e.cik:010d}.json"
            if refresh or not path.exists():
                if client is None:
                    client = SecClient()
                client.download(FACTS_URL.format(cik=e.cik), path, refresh=refresh)
            facts[e.cik] = json.loads(path.read_text(encoding="utf-8"))
        values = {
            key: v
            for key, c in CONCEPTS.items()
            if (v := fy_values(facts[e.cik], c, e.accession, e.report_date))
        }
        text_path = PROCESSED_DIR / "text" / f"{e.doc_id}.txt"
        text = text_path.read_text(encoding="utf-8")
        docs.append(Doc(e, names.get(e.ticker, e.company), text, values))
    return docs


def write_jsonl(items: list[dict[str, Any]], path: Path = OUT_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        for it in items:
            f.write(json.dumps(it, ensure_ascii=False) + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--refresh", action="store_true", help="re-download company facts"
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        items = build_items(load_docs(None, args.refresh))
    except SecError as e:
        log.error("%s", e)
        return 2
    write_jsonl(items)
    by_cat: dict[str, list[int]] = {}
    for it in items:
        by_cat.setdefault(it["category"], []).append(len(it["gold_spans"]))
    print(f"Wrote {len(items)} items to {OUT_PATH.relative_to(REPO_ROOT)}")
    for cat, spans in by_cat.items():
        print(
            f"  {cat:<13}{len(spans):>4} items, "
            f"{sum(1 for s in spans if s == 0)} without gold spans"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
