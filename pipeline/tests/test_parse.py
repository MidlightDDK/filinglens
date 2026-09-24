from pathlib import Path

import pytest

from pipeline.parse import ParsedDoc, parse_filing, table_to_markdown

FIXTURES = Path(__file__).parent / "fixtures"
ITEMS = ["1", "1A", "7", "7A", "8"]


def parse(name: str, aliases: dict | None = None) -> ParsedDoc:
    return parse_filing((FIXTURES / name).read_bytes(), "ACME-FY2025", ITEMS, aliases)


def block_texts(doc: ParsedDoc) -> list[str]:
    return [doc.text[b.char_start : b.char_end] for b in doc.blocks]


@pytest.mark.parametrize("name", ["workiva.html", "legacy.html"])
def test_finds_all_items_in_order(name: str) -> None:
    doc = parse(name)
    assert list(doc.items) == ITEMS
    assert [b.item for b in doc.blocks] == sorted(
        (b.item for b in doc.blocks), key=ITEMS.index
    )


@pytest.mark.parametrize("name", ["workiva.html", "legacy.html"])
def test_offsets_rebuild_the_text(name: str) -> None:
    doc = parse(name)
    assert "\n\n".join(block_texts(doc)) == doc.text
    assert all(b.char_end > b.char_start for b in doc.blocks)


def test_skips_toc_hidden_xbrl_and_page_furniture() -> None:
    doc = parse("workiva.html")
    assert doc.text.startswith(
        "Item 1. Business\n\n"
    )  # the real heading, not the TOC row
    for gone in [
        "HIDDENXBRL",
        "Table of Contents",
        "Form 10-K",
        "cover page",
        "PART II",
    ]:
        assert gone not in doc.text


def test_drops_unkept_items() -> None:
    doc = parse("workiva.html")
    assert "Unresolved Staff Comments" not in doc.text  # Item 1B
    assert "Disagreements" not in doc.text  # Item 9
    assert "We own a warehouse" not in parse("legacy.html").text  # Item 2


def test_split_item_heading_and_heading_paths() -> None:
    doc = parse("workiva.html")
    by_text = dict(zip(block_texts(doc), doc.blocks, strict=True))
    assert by_text["Item 1A."].type == "heading"
    assert by_text["Risk Factors"].type == "heading"
    assert by_text["Risk Factors"].item == "1A"
    para = by_text["The market is highly competitive."]
    assert para.type == "paragraph"
    assert para.heading_path == ["Item 1 Business", "Company Background", "Competition"]
    assert by_text["\N{BULLET} Roller skates for coyotes."].type == "paragraph"
    assert by_text["\N{BULLET} Tunnels painted on rocks."].type == "paragraph"


def test_financial_table_to_markdown_with_unit_line() -> None:
    doc = parse("workiva.html")
    tables = [
        t
        for t, b in zip(block_texts(doc), doc.blocks, strict=True)
        if b.type == "table"
    ]
    assert tables[0] == (
        "(In millions, except percentages)\n"
        "|  | 2025 | 2024 | Change |\n"
        "| --- | --- | --- | --- |\n"
        "| Americas | $1,200 | $1,000 | 20% |\n"
        "| Europe | (50) | 40 | (225)% |"
    )
    assert tables[1].splitlines()[0] == "| (In millions) | 2025 | 2024 |"
    assert (
        "(In millions, except percentages)\n\n" not in doc.text
    )  # unit line merged, not duplicated


def test_legacy_toc_paragraphs_page_numbers_and_short_item() -> None:
    doc = parse("legacy.html")
    assert doc.text.startswith("Item 1. Business.\n\nAcme Legacy makes anvils")
    assert "- 3 -" not in doc.text
    assert "\n\n2\n\n" not in doc.text
    assert "Item 7A is only 82 chars" in doc.warnings


def test_table_header_rows_are_combined() -> None:
    md = table_to_markdown(
        [
            [("(In millions)", 1), ("", 1), ("", 1)],
            [("", 1), ("Year Ended", 2)],
            [("", 1), ("2025", 1), ("2024", 1)],
            [("Revenue", 1), ("10", 1), ("9", 1)],
        ]
    )
    assert md == (
        "| (In millions) | Year Ended 2025 | 2024 |\n"
        "| --- | --- | --- |\n"
        "| Revenue | 10 | 9 |"
    )


def test_single_column_table_is_not_markdown() -> None:
    assert table_to_markdown([[("a", 1)], [("b", 1)]]) is None


BANK_HTML = b"""<html><body>
<p>Contents</p>
<p><b>Management's discussion and analysis</b></p>
<p>Consolidated Financial Statements</p>
<p><b>Item 1. Business</b></p>
<p>Business text.</p>
<p><b>Item 7. Management's Discussion and Analysis</b></p>
<p>Refer to the Management's discussion and analysis section.</p>
<p><b>Item 8. Financial Statements</b></p>
<p><b>Item 15. Exhibits</b></p>
<p><b>Management's discussion and analysis</b></p>
<p>MD&amp;A overview text for a filer that prints items as report sections.</p>
<p><b>Market Risk Management</b></p>
<p>Value-at-risk text.</p>
<p><b>Country Risk Management</b></p>
<p>Country exposure text that is still part of MD&amp;A.</p>
<p><b>Consolidated Financial Statements</b></p>
<p>Balance sheet text.</p>
<p><b>Glossary</b></p>
<p>Glossary text.</p>
</body></html>"""


def test_configured_sections_add_nest_and_skip_toc_copies() -> None:
    sections = {
        "7": {
            "start": "management's discussion and analysis",
            "end": "consolidated financial statements",
        },
        "7A": {"start": "market risk management", "end": "country risk management"},
        "8": {"start": "consolidated financial statements", "end": "glossary"},
    }
    doc = parse_filing(BANK_HTML, "BANK-FY2025", ITEMS, sections)
    item_of = {doc.text[b.char_start : b.char_end]: b.item for b in doc.blocks}
    assert item_of["Business text."] == "1"
    assert item_of["Refer to the Management's discussion and analysis section."] == "7"
    assert (
        item_of["MD&A overview text for a filer that prints items as report sections."]
        == "7"
    )
    assert item_of["Value-at-risk text."] == "7A"
    assert item_of["Country exposure text that is still part of MD&A."] == "7"
    assert item_of["Balance sheet text."] == "8"
    assert "Glossary text." not in item_of
    assert "Consolidated Financial Statements" in item_of  # the section's own heading
    assert doc.text.count("Consolidated Financial Statements") == 1  # not the TOC copy
    assert "Item 1A not found" in doc.warnings


def test_missing_configured_section_is_a_warning() -> None:
    sections = {"8": {"start": "notes", "end": "glossary"}}
    doc = parse_filing(BANK_HTML, "BANK-FY2025", ITEMS, sections)
    assert "configured section for Item 8 not found" in doc.warnings


def _page(*lines: str) -> str:
    body = "".join(lines)
    nav = '<div><a href="#toc">Table of Contents</a></div>'
    return f"{nav}<div>Intel Corporation</div>{body}<hr/>"


def test_font_size_headings_and_running_headers() -> None:
    big = '<div><span style="font-size:18pt">{}</span></div>'
    mid = '<div><span style="font-size:14pt">{}</span></div>'
    text = '<div><span style="font-size:9pt">{}</span></div>'
    footer = "<table><tr><td>Our Strategy</td><td>{}</td></tr></table>"
    pages = [
        _page(
            '<div><span style="font-size:9pt">Item 1. Business</span></div>',
            big.format("Our Strategy"),
            mid.format("Our Products"),
            text.format("We make chips for computers of all kinds and sizes."),
            footer.format(4),
        ),
        _page(
            mid.format("Our Customers"),
            text.format("We sell to computer makers and to cloud providers."),
            footer.format(5),
        ),
        _page(
            text.format("Our largest customers buy many chips every year."),
            text.format("Item 1A. Risk Factors"),
            text.format("Chip demand may fall."),
        ),
    ]
    html = ("<html><body>" + "".join(pages) + "</body></html>").encode()
    doc = parse_filing(html, "CHIP-FY2025", ITEMS)
    by_text = dict(zip(block_texts(doc), doc.blocks, strict=True))
    assert "Intel Corporation" not in by_text  # running header, 2nd line of every page
    assert not any(t.startswith("Our Strategy ") for t in by_text)  # section + page no.
    assert by_text[
        "We sell to computer makers and to cloud providers."
    ].heading_path == [
        "Item 1 Business",
        "Our Strategy",
        "Our Customers",
    ]
    assert by_text["Our Products"].type == "heading"
