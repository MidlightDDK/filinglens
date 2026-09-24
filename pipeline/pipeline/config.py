"""Repo paths and corpus.yaml loading."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
CORPUS_PATH = REPO_ROOT / "pipeline" / "config" / "corpus.yaml"
DATA_DIR = REPO_ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
MANIFEST_PATH = RAW_DIR / "manifest.json"
PROCESSED_DIR = DATA_DIR / "processed"
MODELS_DIR = DATA_DIR / "models"

ITEM_TITLES = {
    "1": "Business",
    "1A": "Risk Factors",
    "7": "Management's Discussion and Analysis of Financial Condition and Results "
    "of Operations",
    "7A": "Quantitative and Qualitative Disclosures About Market Risk",
    "8": "Financial Statements and Supplementary Data",
}


@dataclass(frozen=True)
class Company:
    ticker: str
    name: str
    # item -> {start, end} heading regexes, for filings that print an item as an
    # annual-report section instead of under an "Item N" heading.
    sections: dict[str, dict[str, str]] = field(default_factory=dict)


@dataclass(frozen=True)
class Corpus:
    form: str
    filings_per_company: int
    items: list[str]
    companies: list[Company]

    def company(self, ticker: str) -> Company:
        return next(c for c in self.companies if c.ticker == ticker)


def load_corpus(path: Path = CORPUS_PATH) -> Corpus:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    companies = [
        Company(
            ticker=c["ticker"].upper(),
            name=c["name"],
            sections={
                str(k).upper(): {"start": v["start"], "end": v["end"]}
                for k, v in (c.get("sections") or {}).items()
            },
        )
        for c in raw["companies"]
    ]
    return Corpus(
        form=raw["form"],
        filings_per_company=int(raw["filings_per_company"]),
        items=[str(i).upper() for i in raw["items"]],
        companies=companies,
    )
