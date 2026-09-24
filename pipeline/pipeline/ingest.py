"""Download the latest 10-Ks listed in corpus.yaml into data/raw/; write the manifest.

Usage: python -m pipeline.ingest [--refresh]   (needs SEC_USER_AGENT)
--refresh re-fetches the ticker map and filing lists; cached filings are never
re-downloaded.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from pipeline.config import MANIFEST_PATH, RAW_DIR, Corpus, load_corpus
from pipeline.sec import ARCHIVE_URL, SUBMISSIONS_URL, TICKERS_URL, SecClient, SecError

log = logging.getLogger("pipeline.ingest")

_DEI_FY = re.compile(
    r"""<ix:nonNumeric[^>]*name=["']dei:DocumentFiscalYearFocus["'][^>]*>(.*?)</ix:nonNumeric>""",
    re.IGNORECASE | re.DOTALL,
)


@dataclass(frozen=True)
class Filing:
    accession: str
    filing_date: str
    report_date: str
    primary_document: str


@dataclass(frozen=True)
class ManifestEntry:
    doc_id: str
    ticker: str
    company: str
    cik: int
    fy: int
    form: str
    accession: str
    filing_date: str
    report_date: str
    url: str
    path: str  # relative to data/raw
    sha256: str


def filings_from_block(block: dict[str, list[Any]], form: str) -> list[Filing]:
    """Rows of `form` from a submissions `filings.recent` block or an older page."""
    return [
        Filing(
            accession=block["accessionNumber"][i],
            filing_date=block["filingDate"][i],
            report_date=block["reportDate"][i],
            primary_document=block["primaryDocument"][i],
        )
        for i, f in enumerate(block["form"])
        if f == form
    ]


def fiscal_year(html: bytes, report_date: str) -> int:
    """dei:DocumentFiscalYearFocus from the inline XBRL; else the period-end year
    (a period ending in the first week of January belongs to the prior fiscal year)."""
    m = _DEI_FY.search(html.decode("utf-8", errors="replace"))
    if m:
        digits = re.search(r"\d{4}", re.sub(r"<[^>]+>", "", m.group(1)))
        if digits:
            return int(digits.group())
    year, month, day = (int(p) for p in report_date.split("-"))
    return year - 1 if month == 1 and day <= 7 else year


def _cached_json(client: SecClient, url: str, path: Path, refresh: bool) -> Any:
    client.download(url, path, refresh=refresh)
    return json.loads(path.read_text(encoding="utf-8"))


def latest_filings(
    client: SecClient, cik: int, form: str, n: int, refresh: bool
) -> list[Filing]:
    sec_dir = RAW_DIR / "sec"
    name = f"CIK{cik:010d}.json"
    subs = _cached_json(
        client, SUBMISSIONS_URL.format(name=name), sec_dir / name, refresh
    )
    filings = filings_from_block(subs["filings"]["recent"], form)
    # Frequent filers (e.g. banks issuing notes) push older 10-Ks into paged files.
    for page in subs["filings"].get("files", []):
        if len(filings) >= n:
            break
        older = _cached_json(
            client,
            SUBMISSIONS_URL.format(name=page["name"]),
            sec_dir / page["name"],
            refresh,
        )
        filings += filings_from_block(older, form)
    filings.sort(key=lambda f: f.filing_date, reverse=True)
    return filings[:n]


def ingest(corpus: Corpus, client: SecClient, refresh: bool = False) -> list[str]:
    """Download everything; returns failure messages (also logged)."""
    tickers = _cached_json(
        client, TICKERS_URL, RAW_DIR / "sec" / "company_tickers.json", refresh
    )
    cik_by_ticker = {
        row["ticker"].upper(): int(row["cik_str"]) for row in tickers.values()
    }

    entries: list[ManifestEntry] = []
    failures: list[str] = []
    for company in corpus.companies:
        try:
            cik = cik_by_ticker.get(company.ticker)
            if cik is None:
                raise SecError("ticker not found in company_tickers.json")
            filings = latest_filings(
                client, cik, corpus.form, corpus.filings_per_company, refresh
            )
            if len(filings) < corpus.filings_per_company:
                failures.append(
                    f"{company.ticker}: only {len(filings)} {corpus.form} filings "
                    f"(wanted {corpus.filings_per_company})"
                )
        except (SecError, KeyError, ValueError) as e:
            failures.append(f"{company.ticker}: {e}")
            continue
        seen_fy: set[int] = set()
        for f in filings:
            try:
                acc = f.accession.replace("-", "")
                url = ARCHIVE_URL.format(
                    cik=cik, accession=acc, document=f.primary_document
                )
                rel = Path(company.ticker) / acc / f.primary_document
                fetched = client.download(url, RAW_DIR / rel)
                html = (RAW_DIR / rel).read_bytes()
                fy = fiscal_year(html, f.report_date)
                if fy in seen_fy:
                    raise ValueError(
                        f"duplicate fiscal year FY{fy} (accession {f.accession})"
                    )
                seen_fy.add(fy)
                entries.append(
                    ManifestEntry(
                        doc_id=f"{company.ticker}-FY{fy}",
                        ticker=company.ticker,
                        company=company.name,
                        cik=cik,
                        fy=fy,
                        form=corpus.form,
                        accession=f.accession,
                        filing_date=f.filing_date,
                        report_date=f.report_date,
                        url=url,
                        path=rel.as_posix(),
                        sha256=hashlib.sha256(html).hexdigest(),
                    )
                )
                log.info(
                    "%s-FY%d %s (%s)",
                    company.ticker,
                    fy,
                    rel.as_posix(),
                    "downloaded" if fetched else "cached",
                )
            except (SecError, OSError, ValueError) as e:
                failures.append(f"{company.ticker} {f.accession}: {e}")

    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    manifest = [asdict(e) for e in sorted(entries, key=lambda e: (e.ticker, -e.fy))]
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    for msg in failures:
        log.error("FAILED %s", msg)
    log.info(
        "%d filings in %s, %d failures", len(entries), MANIFEST_PATH, len(failures)
    )
    return failures


def load_manifest() -> list[ManifestEntry]:
    return [
        ManifestEntry(**e)
        for e in json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--refresh", action="store_true", help="re-fetch ticker map and filing lists"
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        client = SecClient()
    except SecError as e:
        log.error("%s", e)
        return 2
    return 1 if ingest(load_corpus(), client, refresh=args.refresh) else 0


if __name__ == "__main__":
    sys.exit(main())
