"""Parse 10-K HTML into normalized text + blocks, keeping only the configured Items.

Writes data/processed/text/{doc_id}.txt and blocks/{doc_id}.jsonl. All offsets are
character offsets into the text file.
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import NamedTuple

import lxml.html
from lxml.html import HtmlElement

from pipeline.config import ITEM_TITLES

BLOCK_TAGS = {
    "address", "article", "blockquote", "body", "center", "dd", "div", "dl", "dt",
    "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "html", "li", "ol", "p",
    "pre", "section", "table", "td", "th", "tr", "ul",
}  # fmt: skip
SKIP_TAGS = {"head", "script", "style", "title", "noscript", "ix:header"}
KNOWN_ITEMS = {
    "1", "1A", "1B", "1C", "2", "3", "4", "5", "6", "7", "7A", "8",
    "9", "9A", "9B", "9C", "10", "11", "12", "13", "14", "15", "16",
}  # fmt: skip

ITEM_RE = re.compile(
    r"^item\s*(\d{1,2}[a-c]?)\b(?:\s*(?:and|&|,)\s*\d{1,2}[a-c]?\b)*"
    r"\s*[.:\-\N{EN DASH}\N{EM DASH}]?\s*(.*)$",
    re.IGNORECASE,
)
UNIT_RE = re.compile(
    r"\b(?:in|amounts in|dollars in)\s+(?:millions|thousands|billions)\b", re.I
)
PAGE_NUM_RE = re.compile(
    r"^(?:page\s*)?[-\N{EN DASH}\N{EM DASH}]?\s*(?:\d{1,3}|[ivxlc]{1,6})\s*"
    r"[-\N{EN DASH}\N{EM DASH}]?$",
    re.I,
)
NAV_RE = re.compile(
    r"^(?:return to |back to )?(?:table of contents|index|contents)$", re.I
)
# "Our Strategy 4" / "12 Notes to Financial Statements": section name + page number.
FOOTER_RE = re.compile(r"^(?:\d{1,3}\s+[A-Za-z].{0,58}|[A-Za-z].{0,58}?\s+\d{1,3})$")
CURRENCY_PREFIXES = {"$", "(", "$(", "($", "\N{EURO SIGN}", "\N{POUND SIGN}"}
SUFFIXES = {")", "%", ")%", "%)"}
MAX_HEADING_CHARS = 150
SHORT_CHARS = 100  # longest line that can be a running header/footer
PAGE_EDGE = 3  # blocks on each side of a page break that count as its edge
LAYOUT_CELL_CHARS = 400  # a cell this long means the table is page layout, not data
MIN_ITEM_CHARS = 300  # warn below this (usually a cross-reference to another section)

_TRANS = str.maketrans(
    {
        "\N{LEFT SINGLE QUOTATION MARK}": "'",
        "\N{RIGHT SINGLE QUOTATION MARK}": "'",
        "\N{LEFT DOUBLE QUOTATION MARK}": '"',
        "\N{RIGHT DOUBLE QUOTATION MARK}": '"',
        "\N{ZERO WIDTH SPACE}": "",
        "\N{SOFT HYPHEN}": "",
        "\N{ZERO WIDTH NO-BREAK SPACE}": "",
    }
)
_WS = re.compile(r"\s+")
_BULLETS = r"\N{BULLET}\N{BLACK SMALL SQUARE}\N{BLACK CIRCLE}"
_BULLET = re.compile(rf"^([{_BULLETS}])(?=\S)")
_BULLET_ONLY = re.compile(rf"[{_BULLETS}\-]")


def norm(s: str) -> str:
    s = _WS.sub(" ", unicodedata.normalize("NFKC", s).translate(_TRANS)).strip()
    return _BULLET.sub(r"\1 ", s)


class Style(NamedTuple):
    bold: bool = False
    emph: bool = False  # italic or underline
    size: float = 0.0  # font size in pt; 0 = unknown


@dataclass
class RawBlock:
    text: str
    type: str  # paragraph | table
    bold: bool = False  # every word is bold
    emph: bool = False  # every word is italic or underlined
    size: float = 0.0  # smallest font size among its words (0 = unknown)


@dataclass
class Block:
    block_id: str
    item: str
    heading_path: list[str]
    type: str  # heading | paragraph | table
    char_start: int
    char_end: int


@dataclass
class ParsedDoc:
    doc_id: str
    text: str
    blocks: list[Block]
    items: dict[str, int]  # item -> characters of text, in order of first appearance
    warnings: list[str] = field(default_factory=list)


# ---------------------------------------------------------------- DOM -> raw blocks


def _tag(el: object) -> str | None:
    tag = getattr(el, "tag", None)
    return tag.lower() if isinstance(tag, str) else None


def _style(el: HtmlElement) -> dict[str, str]:
    out = {}
    for decl in (el.get("style") or "").split(";"):
        k, sep, v = decl.partition(":")
        if sep:
            out[k.strip().lower()] = v.strip().lower()
    return out


def _hidden(tag: str, style: dict[str, str]) -> bool:
    return (
        tag in SKIP_TAGS
        or style.get("display") == "none"
        or style.get("visibility") == "hidden"
    )


def _restyle(tag: str, css: dict[str, str], st: Style) -> Style:
    bold, emph, size = st
    weight = css.get("font-weight", "")
    if tag in ("b", "strong") or weight in (
        "bold",
        "bolder",
        "600",
        "700",
        "800",
        "900",
    ):
        bold = True
    elif weight in ("normal", "400", "300", "lighter"):
        bold = False
    if tag in ("i", "em", "u") or css.get("font-style") == "italic":
        emph = True
    elif css.get("font-style") == "normal":
        emph = False
    if "underline" in css.get("text-decoration", ""):
        emph = True
    m = re.fullmatch(r"([\d.]+)\s*(pt|px)", css.get("font-size", ""))
    if m:
        size = float(m.group(1)) * (0.75 if m.group(2) == "px" else 1.0)
    return Style(bold, emph, size)


def _page_break(css: dict[str, str], where: str) -> bool:
    return (
        css.get(f"page-break-{where}") == "always"
        or css.get(f"break-{where}") == "page"
    )


def _summary(parts: list[tuple[str, Style]]) -> Style:
    """Style shared by all words: bold/emph only if every word has it, smallest size."""
    words = [st for t, st in parts if any(ch.isalnum() for ch in t)]
    if not words:
        return Style()
    sizes = [st.size for st in words]
    return Style(
        all(st.bold for st in words),
        all(st.emph for st in words),
        min(sizes) if all(sizes) else 0.0,
    )


class _Walker:
    """Flattens the DOM into paragraphs and tables; None entries mark page breaks."""

    def __init__(self) -> None:
        self.out: list[RawBlock | None] = []
        self._buf: list[tuple[str, Style]] = []

    def flush(self) -> None:
        if not self._buf:
            return
        text = norm("".join(t for t, _ in self._buf))
        if text:
            st = _summary(self._buf)
            self.out.append(RawBlock(text, "paragraph", st.bold, st.emph, st.size))
        self._buf = []

    def page_break(self) -> None:
        self.flush()
        self.out.append(None)

    def walk(self, el: HtmlElement, st: Style) -> None:
        tag = _tag(el)
        if tag is None:
            return
        css = _style(el)
        if _hidden(tag, css):
            return
        if _page_break(css, "before"):
            self.page_break()
        if tag == "hr":
            self.page_break()
        elif tag == "br":
            self.flush()
        elif tag == "table":
            self.flush()
            self.table(el, _restyle(tag, css, st))
        else:
            self.container(el, tag, css, st)
        if _page_break(css, "after"):
            self.page_break()

    def container(
        self, el: HtmlElement, tag: str, css: dict[str, str], st: Style
    ) -> None:
        block = tag in BLOCK_TAGS
        if block:
            self.flush()
        st = _restyle(tag, css, st)
        if el.text:
            self._buf.append((el.text, st))
        for child in el:
            self.walk(child, st)
            if child.tail:
                self._buf.append((child.tail, st))
        if block:
            self.flush()

    def table(self, el: HtmlElement, st: Style) -> None:
        rows: list[list[tuple[str, int, Style]]] = []  # (text, colspan, style)
        for tr in el.xpath("./tr | ./thead/tr | ./tbody/tr | ./tfoot/tr"):
            cells = []
            for td in tr:
                tag = _tag(td)
                if tag not in ("td", "th") or _hidden(tag, _style(td)):
                    continue
                sub = _Walker()
                sub.container(td, "td", _style(td), st)
                parts = [b for b in sub.out if b is not None]
                text = " ".join(b.text for b in parts)
                cst = _summary([(b.text, Style(b.bold, b.emph, b.size)) for b in parts])
                try:
                    span = max(1, min(int(td.get("colspan") or 1), 64))
                except ValueError:
                    span = 1
                cells.append((text, span, cst))
            if any(t for t, _, _ in cells):
                rows.append(cells)
        if not rows:
            return
        if max(len(t) for r in rows for t, _, _ in r) > LAYOUT_CELL_CHARS:
            self.container(el, "table", {}, st)  # page layout: read as ordinary blocks
            return
        if len(rows) == 1:  # bullets, footnotes, and headings laid out as one row
            cells = [(t, cst) for t, _, cst in rows[0] if t]
            s = _summary(cells)
            text = " ".join(t for t, _ in cells)
            self.out.append(RawBlock(text, "paragraph", s.bold, s.emph, s.size))
            return
        md = table_to_markdown([[(t, s) for t, s, _ in r] for r in rows])
        if md is None:
            self.container(el, "table", {}, st)
            return
        prev = self.out[-1] if self.out else None
        if prev is not None and prev.type == "paragraph" and len(prev.text) <= 200:
            if UNIT_RE.search(prev.text) and not UNIT_RE.search(md.split("\n", 2)[0]):
                self.out.pop()
                md = f"{prev.text}\n{md}"
        self.out.append(RawBlock(md, "table"))


def table_to_markdown(rows: list[list[tuple[str, int]]]) -> str | None:
    """Rows of (cell text, colspan) -> Markdown table; None if it has < 2 columns."""
    width = max(sum(s for _, s in r) for r in rows)
    grid = [[""] * width for _ in rows]
    spans: list[tuple[int, int, int, str]] = []
    for r, cells in enumerate(rows):
        c = 0
        for text, span in cells:
            if span == 1:
                grid[r][c] = text
            elif text:
                spans.append((r, c, c + span, text))
            c += span
    # Glue "$" / "(" onto the following value and ")" / "%" onto the preceding one.
    for row in grid:
        for i, cell in enumerate(row):
            if cell in CURRENCY_PREFIXES:
                j = next((k for k in range(i + 1, width) if row[k]), None)
                if j is not None and row[j] not in CURRENCY_PREFIXES:
                    row[j], row[i] = cell + row[j], ""
            elif cell in SUFFIXES:
                j = next((k for k in range(i - 1, -1, -1) if row[k]), None)
                if j is not None:
                    row[j], row[i] = row[j] + cell, ""
    # A spanning cell (e.g. a year over "$ | value | )") goes to the first column in its
    # span that holds values, so it lines up with them once empty columns are folded.
    content = {c for row in grid for c, cell in enumerate(row) if cell}
    for r, s, e, text in spans:
        target = s if s == 0 else next((c for c in range(s, e) if c in content), e - 1)
        grid[r][target] = f"{grid[r][target]} {text}".strip()
    cols = [list(col) for col in zip(*grid, strict=True) if any(col)]
    # Fold adjacent columns that never both hold text in one row (never into the
    # label column).
    i = 1
    while i + 1 < len(cols):
        a, b = cols[i], cols[i + 1]
        if all(not (x and y) for x, y in zip(a, b, strict=True)):
            cols[i] = [x or y for x, y in zip(a, b, strict=True)]
            del cols[i + 1]
        else:
            i += 1
    if len(cols) < 2:
        return None
    body = [list(r) for r in zip(*cols, strict=True) if any(r)]
    # Header rows: leading rows without a label, plus label-only title rows before them.
    n_head, seen_values = 0, False
    for row in body[:4]:
        label, values = bool(row[0]), any(row[1:])
        if (label and values) or (label and seen_values):
            break
        seen_values |= values
        n_head += 1
    if n_head == 0 or n_head == len(body):
        n_head = 1
    header = [" ".join(r[c] for r in body[:n_head] if r[c]) for c in range(len(cols))]

    def line(cells: list[str]) -> str:
        return "| " + " | ".join(c.replace("|", "\\|") for c in cells) + " |"

    out = [line(header), "| " + " | ".join("---" for _ in cols) + " |"]
    out += [line(r) for r in body[n_head:]]
    return "\n".join(out)


def raw_blocks(html: bytes) -> list[RawBlock | None]:
    try:
        text = html.decode("utf-8")
    except UnicodeDecodeError:
        text = html.decode("cp1252", errors="replace")
    text = re.sub(r"^\s*<\?xml[^>]*\?>", "", text)
    root = lxml.html.document_fromstring(
        text, parser=lxml.html.HTMLParser(huge_tree=True)
    )
    w = _Walker()
    w.walk(root, Style())
    w.flush()
    return w.out


# ---------------------------------------------------------------- page furniture


def _short(b: RawBlock) -> bool:
    return b.type == "paragraph" and len(b.text) <= SHORT_CHARS


def drop_page_furniture(raw: list[RawBlock | None]) -> list[RawBlock]:
    """Drop page numbers, nav links, running headers/footers, and page-break markers."""
    seq = [
        b
        for b in raw
        if b is None
        or not (_short(b) and (PAGE_NUM_RE.match(b.text) or NAV_RE.match(b.text)))
    ]
    blocks: list[RawBlock] = []
    edge: list[bool] = []
    since_break = 0
    for b in seq:
        if b is None:
            for k in range(1, min(PAGE_EDGE, len(edge)) + 1):
                edge[-k] = True
            since_break = 0
            continue
        blocks.append(b)
        edge.append(since_break < PAGE_EDGE)
        since_break += 1

    def key(b: RawBlock) -> str:
        t = b.text.lower()
        return t if ITEM_RE.match(t) else re.sub(r"\d+", "#", t)

    at_edges = Counter(
        key(b) for b, e in zip(blocks, edge, strict=True) if e and _short(b)
    )
    anywhere = Counter(key(b) for b in blocks if _short(b))
    kept = []
    for b, e in zip(blocks, edge, strict=True):
        if _short(b) and not UNIT_RE.search(b.text):
            k = key(b)
            if e and (
                at_edges[k] >= 3
                or (FOOTER_RE.match(b.text) and not ITEM_RE.match(b.text))
            ):
                continue
            if (
                anywhere[k] >= 8
                and re.search(r"\d", b.text)
                and re.search(r"[a-z]", b.text, re.I)
            ):
                continue
        prev = kept[-1] if kept else None
        lone_bullet = (
            prev and prev.type == "paragraph" and _BULLET_ONLY.fullmatch(prev.text)
        )
        if lone_bullet and b.type == "paragraph":
            kept.pop()  # a bullet laid out apart from its text
            b = RawBlock(f"{prev.text} {b.text}", "paragraph", size=b.size)
        kept.append(b)
    return kept


# ---------------------------------------------------------------- items and headings


@dataclass
class _Section:
    item: str
    start: int  # block index of its heading
    end: int  # exclusive
    nested: bool  # a configured section: overrides the Item section it sits in


def _cumulative(blocks: list[RawBlock]) -> list[int]:
    cum = [0]
    for b in blocks:
        cum.append(cum[-1] + len(b.text))
    return cum


def find_sections(blocks: list[RawBlock]) -> list[_Section]:
    """One section per "Item N" heading. Table-of-contents copies are skipped: the
    occurrence followed by the most text before the next Item heading wins."""
    cands = []
    for i, b in enumerate(blocks):
        m = b.type == "paragraph" and len(b.text) <= 200 and ITEM_RE.match(b.text)
        if m and m.group(1).upper() in KNOWN_ITEMS:
            cands.append((i, m.group(1).upper()))
    cum = _cumulative(blocks)
    best: dict[str, tuple[int, int]] = {}  # item -> (body length, block index)
    for n, (i, item) in enumerate(cands):
        nxt = cands[n + 1][0] if n + 1 < len(cands) else len(blocks)
        length = cum[nxt] - cum[i + 1]
        if item not in best or length >= best[item][0]:  # ties: the later, non-TOC one
            best[item] = (length, i)
    starts = sorted(i for _, i in best.values())
    return [
        _Section(item, i, next((k for k in starts if k > i), len(blocks)), False)
        for item, (_, i) in best.items()
    ]


def find_configured_sections(
    blocks: list[RawBlock], spec: dict[str, dict[str, str]]
) -> tuple[list[_Section], list[str]]:
    """Sections given as {item: {start, end}} heading regexes (full match), for filings
    that print an item as an annual-report section. An occurrence counts only if its end
    heading comes before the next occurrence of its start heading (TOC copies fail
    this); the longest valid one wins."""
    paras = [(i, b.text) for i, b in enumerate(blocks) if _short_para(b)]
    cum = _cumulative(blocks)
    sections, warnings = [], []
    for item, rx in spec.items():
        start_rx, end_rx = re.compile(rx["start"], re.I), re.compile(rx["end"], re.I)
        starts = [i for i, t in paras if start_rx.fullmatch(t)]
        best: tuple[int, int, int] | None = None
        for n, s in enumerate(starts):
            limit = starts[n + 1] if n + 1 < len(starts) else len(blocks)
            e = next(
                (i for i, t in paras if s < i < limit and end_rx.fullmatch(t)), None
            )
            if e is not None and (best is None or cum[e] - cum[s + 1] >= best[0]):
                best = (cum[e] - cum[s + 1], s, e)
        if best is None:
            warnings.append(f"configured section for Item {item} not found")
        else:
            sections.append(_Section(item, best[1], best[2], True))
    return sections, warnings


def _short_para(b: RawBlock) -> bool:
    return b.type == "paragraph" and len(b.text) <= 200


def _body_size(blocks: list[RawBlock]) -> float:
    """Most common font size by characters (0 if sizes are unknown)."""
    sizes = Counter()
    for b in blocks:
        if b.type == "paragraph" and b.size:
            sizes[b.size] += len(b.text)
    return sizes.most_common(1)[0][0] if sizes else 0.0


def _heading_level(b: RawBlock, body: float) -> int | None:
    """Heading tier, outermost first: 1 = much larger type, 2 = larger type,
    3 = bold or all caps, 4 = italic or underlined. None = not a heading."""
    t = b.text
    if (
        b.type != "paragraph"
        or len(t) > MAX_HEADING_CHARS
        or not re.search(r"[A-Za-z]{2}", t)
        or t.endswith((",", ";"))
        or (t.endswith(".") and len(t) > 80)
    ):
        return None
    if body and b.size >= body + 6:
        return 1
    if body and b.size >= body + 2:
        return 2
    if b.bold or (t.isupper() and len(t) <= 100):
        return 3
    if b.emph:
        return 4
    return None


def parse_filing(
    html: bytes,
    doc_id: str,
    keep_items: list[str],
    configured: dict[str, dict[str, str]] | None = None,
) -> ParsedDoc:
    blocks = drop_page_furniture(raw_blocks(html))
    sections = find_sections(blocks)
    extra, warnings = find_configured_sections(blocks, configured or {})
    sections += extra

    # Item of each block: Item sections are disjoint; configured sections override
    # whatever they sit in, and a later-starting one overrides an earlier one.
    item_of: list[str | None] = [None] * len(blocks)
    for s in sorted(sections, key=lambda s: (s.nested, s.start)):
        for k in range(s.start, s.end):
            item_of[k] = s.item
    heading_idx = {s.start for s in sections}
    for s in sections:  # "Item 7." on one line and its title on the next
        m = ITEM_RE.match(blocks[s.start].text)
        nxt = s.start + 1
        if (
            m
            and not m.group(2)
            and nxt < s.end
            and len(blocks[nxt].text) <= MAX_HEADING_CHARS
        ):
            heading_idx.add(nxt)

    body = _body_size(blocks)
    parts: list[str] = []
    out: list[Block] = []
    pos = 0
    current: str | None = None
    stack: list[tuple[int, str]] = []  # open headings as (tier, text)
    for k, b in enumerate(blocks):
        item = item_of[k]
        if item not in keep_items:
            continue
        if item != current:
            current, stack = item, []
        path = [f"Item {item} {ITEM_TITLES.get(item, '')}".strip()]
        level = None if k in heading_idx else _heading_level(b, body)
        if level:
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, b.text))
        if k not in heading_idx:
            path += [t for _, t in stack]
        btype = "heading" if k in heading_idx or level else b.type
        if pos:
            parts.append("\n\n")
            pos += 2
        parts.append(b.text)
        out.append(
            Block(f"{doc_id}-{len(out):05d}", item, path, btype, pos, pos + len(b.text))
        )
        pos += len(b.text)

    items: dict[str, int] = {}
    for blk in out:
        items[blk.item] = items.get(blk.item, 0) + blk.char_end - blk.char_start
    for item in keep_items:
        if item not in items:
            warnings.append(f"Item {item} not found")
        elif items[item] < MIN_ITEM_CHARS:
            warnings.append(f"Item {item} is only {items[item]} chars")
    return ParsedDoc(doc_id, "".join(parts), out, items, warnings)


def write_parsed(doc: ParsedDoc, out_dir: Path) -> None:
    (out_dir / "text").mkdir(parents=True, exist_ok=True)
    (out_dir / "blocks").mkdir(parents=True, exist_ok=True)
    (out_dir / "text" / f"{doc.doc_id}.txt").write_text(
        doc.text, encoding="utf-8", newline="\n"
    )
    with (out_dir / "blocks" / f"{doc.doc_id}.jsonl").open(
        "w", encoding="utf-8", newline="\n"
    ) as f:
        for b in doc.blocks:
            f.write(json.dumps(asdict(b), ensure_ascii=False) + "\n")
