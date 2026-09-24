import re
from pathlib import Path

from pipeline.chunk import fixed_chunks, structure_chunks
from pipeline.parse import Block, ParsedDoc, parse_filing

FIXTURES = Path(__file__).parent / "fixtures"


class WordTokenizer:
    """Offline stand-in for the embedding tokenizer: words and punctuation."""

    def offsets(self, text: str) -> list[tuple[int, int]]:
        return [m.span() for m in re.finditer(r"\w+|[^\w\s]", text)]

    def count(self, text: str) -> int:
        return len(self.offsets(text))


TOK = WordTokenizer()


def doc_from(text: str) -> ParsedDoc:
    block = Block("D-00000", "7", ["Item 7 MD&A"], "paragraph", 0, len(text))
    return ParsedDoc("D-FY2025", text, [block], {"7": len(text)})


def test_fixed_windows_overlap_and_cover_the_text() -> None:
    doc = doc_from(" ".join(f"w{i}" for i in range(95)))
    chunks = fixed_chunks(doc, TOK, size=20, overlap=5)
    assert [c.text.split()[0] for c in chunks] == [
        "w0",
        "w15",
        "w30",
        "w45",
        "w60",
        "w75",
    ]
    assert chunks[-1].text.endswith("w94")
    assert all(c.n_tokens <= 20 for c in chunks)
    assert all(doc.text[c.char_start : c.char_end] == c.text for c in chunks)
    assert chunks[0].item == "7" and chunks[0].chunk_id == "D-FY2025-fixed-00000"


def test_structure_chunks_never_cross_headings_and_carry_the_prefix() -> None:
    doc = parse_filing(
        (FIXTURES / "workiva.html").read_bytes(),
        "ACME-FY2025",
        ["1", "1A", "7", "7A", "8"],
    )
    chunks = structure_chunks(doc, TOK, "Acme", 2025)
    assert chunks[0].text.startswith(
        "Acme FY2025 10-K | Item 1 Business | Company Background\n\n"
    )
    for c in chunks:
        inside = [
            b
            for b in doc.blocks
            if b.char_start < c.char_end and b.char_end > c.char_start
        ]
        assert {tuple(b.heading_path) for b in inside} == {tuple(c.heading_path)}
        assert all(b.type != "heading" for b in inside)
        assert c.n_tokens == TOK.count(c.text)
    competition = next(c for c in chunks if c.heading_path[-1] == "Competition")
    assert competition.text.endswith("\n\nThe market is highly competitive.")


def test_long_paragraph_splits_at_sentences_within_budget() -> None:
    text = " ".join(f"Sentence number {i} is here." for i in range(40))
    chunks = structure_chunks(doc_from(text), TOK, "Acme", 2025, max_tokens=40)
    assert len(chunks) > 1
    assert all(c.n_tokens <= 40 for c in chunks)
    body = [doc_from(text).text[c.char_start : c.char_end] for c in chunks]
    assert all(b.startswith("Sentence number") and b.endswith("here.") for b in body)


def test_large_table_splits_by_rows_and_repeats_header() -> None:
    header = "(In millions)\n| Segment | 2025 |\n| --- | --- |"
    rows = [f"| Segment {i} | {i},000 |" for i in range(30)]
    text = "\n".join([header, *rows])
    doc = ParsedDoc(
        "D-FY2025",
        text,
        [Block("D-00000", "7", ["Item 7 MD&A"], "table", 0, len(text))],
        {},
    )
    chunks = structure_chunks(doc, TOK, "Acme", 2025, table_tokens=80)
    assert len(chunks) > 1
    for c in chunks:
        assert c.n_tokens <= 80
        assert c.text.split("\n\n", 1)[1].startswith(header + "\n| Segment ")
        assert text[c.char_start : c.char_end].startswith("| Segment ")
    assert chunks[-1].text.endswith("| Segment 29 | 29,000 |")


def test_small_table_stays_whole() -> None:
    doc = parse_filing((FIXTURES / "workiva.html").read_bytes(), "ACME-FY2025", ["7"])
    chunks = structure_chunks(doc, TOK, "Acme", 2025)
    table = next(c for c in chunks if "| Americas |" in c.text)
    assert (
        "(In millions, except percentages)" in table.text and "| Europe |" in table.text
    )
