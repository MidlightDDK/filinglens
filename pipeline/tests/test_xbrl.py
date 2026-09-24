from pipeline.ingest import ManifestEntry
from pipeline.xbrl import (
    CONCEPTS,
    Doc,
    FyValues,
    comparison_items,
    find_spans,
    fy_values,
    sample,
    trend_items,
    value_formats,
)

ACCN = "0000000001-25-000001"


def fact(val: float, end: str, start: str | None = None, **kw: str) -> dict:
    row = {"val": val, "end": end, "accn": ACCN, "form": "10-K", "fp": "FY"}
    if start:
        row["start"] = start
    return {**row, **kw}


def facts(tag: str, rows: list[dict], unit: str = "USD") -> dict:
    return {"facts": {"us-gaap": {tag: {"units": {unit: rows}}}}}


def test_current_year_comes_from_the_filing_period_end_not_comparatives() -> None:
    rows = [
        fact(60_922e6, "2024-01-28", "2023-01-30"),  # prior-year comparative
        fact(130_497e6, "2025-01-26", "2024-01-29"),
        fact(39_331e6, "2025-01-26", "2024-10-28"),  # a quarter: wrong duration
        fact(1e9, "2025-01-26", "2024-01-29", accn="other"),  # another filing
        fact(2e9, "2025-01-26", "2024-01-29", form="10-Q"),
    ]
    got = fy_values(facts("Revenues", rows), CONCEPTS["revenue"], ACCN, "2025-01-26")
    assert got == FyValues(130_497e6, 60_922e6)


def test_revenue_falls_back_to_the_contract_revenue_tag() -> None:
    tag = "RevenueFromContractWithCustomerExcludingAssessedTax"
    got = fy_values(
        facts(tag, [fact(5e9, "2024-12-31", "2024-01-01")]),
        CONCEPTS["revenue"],
        ACCN,
        "2024-12-31",
    )
    assert got == FyValues(5e9, None)


def test_instant_concepts_need_no_duration() -> None:
    rows = [fact(8_589e6, "2025-01-26"), fact(7_280e6, "2024-01-28")]
    got = fy_values(
        facts("CashAndCashEquivalentsAtCarryingValue", rows),
        CONCEPTS["cash"],
        ACCN,
        "2025-01-26",
    )
    assert got == FyValues(8_589e6, 7_280e6)


def test_conflicting_current_values_are_skipped() -> None:
    rows = [
        fact(1e9, "2024-12-31", "2024-01-01"),
        fact(2e9, "2024-12-31", "2024-01-01"),
    ]
    got = fy_values(
        facts("NetIncomeLoss", rows), CONCEPTS["net_income"], ACCN, "2024-12-31"
    )
    assert got is None


def test_value_formats() -> None:
    assert value_formats(130_497e6, "USD") == [
        "130,497",
        "130,497,000",
        "130.5 billion",
        "130.50 billion",
    ]
    assert value_formats(39_000_966e3, "USD")[0] == "39,000,966"
    assert value_formats(-18_756e6, "USD")[0] == "18,756"
    assert value_formats(1.0, "USD/shares") == ["1.00"]


TEXT = (
    "Revenue for fiscal year 2025 was $130.5 billion, up 114% from a year ago. "
    "Other items were 130,497 units.\n"
    "| Revenue | $130,497 | $60,922 |\n"
    "| Total | $130,497 | $60,922 |\n"
    "| Revenue | 1,130,497 |\n"
)


def test_spans_need_the_concept_in_the_row_label_or_sentence() -> None:
    spans = [TEXT[s:e] for s, e in find_spans(TEXT, 130_497e6, CONCEPTS["revenue"])]
    assert spans == [
        "Revenue for fiscal year 2025 was $130.5 billion, up 114% from a year ago.",
        "| Revenue | $130,497 | $60,922 |",
    ]


def test_short_spans_are_padded_to_the_overlap_threshold() -> None:
    text = "x" * 40 + "\n| R&D | 813 |\n" + "y" * 40
    ((s, e),) = find_spans(text, 813e6, CONCEPTS["rd"])
    assert e - s >= 30 and s <= 41 and e >= 54


def entry(ticker: str, fy: int) -> ManifestEntry:
    return ManifestEntry(
        f"{ticker}-FY{fy}", ticker, ticker, 1, fy, "10-K", ACCN, "", "", "", "", ""
    )


def test_trend_and_comparison_items() -> None:
    rev = {"revenue": FyValues(130_497e6, 60_922e6)}
    a = Doc(entry("AAA", 2025), "Alpha", TEXT, rev)
    b = Doc(entry("BBB", 2025), "Beta", "", {"revenue": FyValues(100_000e6, None)})
    (trend,) = trend_items(a, None)
    assert trend["id"] == "xbrl-yoy-aaa-fy2025-revenue"
    assert trend["fiscal_years"] == [2024, 2025]
    assert trend["gold_numeric"] == {"value": 114.2, "unit": "%", "tolerance": 0.5}
    groups = {s["group"] for s in trend["gold_spans"]}
    assert groups == {"revenue_fy2025", "revenue_fy2024"}
    assert trend_items(b, None) == []  # no prior value

    (cmp,) = comparison_items(a, b)
    assert cmp["companies"] == ["AAA", "BBB"]
    assert cmp["gold_numeric"]["value"] == 30_497e6
    assert cmp["gold_answer"].startswith("Alpha: $130,497 million")


def test_sample_is_deterministic_and_round_robin() -> None:
    items = [
        {"id": f"x-{t}-{i}", "companies": [t]} for t in ("A", "B") for i in range(5)
    ]
    picked = sample(items, 4, "company")
    assert picked == sample(list(reversed(items)), 4, "company")
    assert sorted(it["companies"][0] for it in picked) == ["A", "A", "B", "B"]
