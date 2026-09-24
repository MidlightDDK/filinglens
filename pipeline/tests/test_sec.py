import gzip
from pathlib import Path

import pytest

from pipeline.ingest import filings_from_block, fiscal_year
from pipeline.sec import SecClient, SecError


class FakeSec:
    def __init__(self, responses: list[tuple[int, bytes, dict[str, str]]]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, dict[str, str]]] = []
        self.sleeps: list[float] = []
        self.now = 0.0

    def fetch(
        self, url: str, headers: dict[str, str]
    ) -> tuple[int, bytes, dict[str, str]]:
        self.calls.append((url, headers))
        return self.responses.pop(0)

    def sleep(self, s: float) -> None:
        self.sleeps.append(s)
        self.now += s

    def client(self, **kw: float) -> SecClient:
        return SecClient(
            "Test User test@example.com",
            fetch=self.fetch,
            sleep=self.sleep,
            clock=lambda: self.now,
            **kw,
        )


def test_fails_fast_without_user_agent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SEC_USER_AGENT", raising=False)
    with pytest.raises(SecError, match="SEC_USER_AGENT"):
        SecClient()


def test_sends_user_agent_and_decodes_gzip() -> None:
    fake = FakeSec([(200, gzip.compress(b"{}"), {"Content-Encoding": "gzip"})])
    assert fake.client().get_json("https://data.sec.gov/x") == {}
    assert fake.calls[0][1]["User-Agent"] == "Test User test@example.com"


def test_retries_429_and_5xx_with_backoff() -> None:
    fake = FakeSec([(429, b"", {"Retry-After": "3"}), (503, b"", {}), (200, b"ok", {})])
    assert fake.client().get("https://www.sec.gov/x") == b"ok"
    assert len(fake.calls) == 3
    assert fake.sleeps == [3.0, 2.0]


def test_does_not_retry_404() -> None:
    fake = FakeSec([(404, b"", {})])
    with pytest.raises(SecError, match="HTTP 404"):
        fake.client().get("https://www.sec.gov/x")
    assert len(fake.calls) == 1


def test_gives_up_after_max_retries() -> None:
    fake = FakeSec([(500, b"", {})] * 3)
    with pytest.raises(SecError, match="after 3 attempts"):
        fake.client(max_retries=2).get("https://www.sec.gov/x")


def test_rate_limit_spaces_requests() -> None:
    fake = FakeSec([(200, b"a", {}), (200, b"b", {})])
    client = fake.client(min_interval=0.2)
    client.get("https://www.sec.gov/a")
    client.get("https://www.sec.gov/b")
    assert fake.sleeps == [pytest.approx(0.2)]


def test_download_skips_cached_files(tmp_path: Path) -> None:
    fake = FakeSec([(200, b"<html/>", {})])
    client = fake.client()
    path = tmp_path / "a" / "doc.htm"
    assert client.download("https://www.sec.gov/doc.htm", path) is True
    assert client.download("https://www.sec.gov/doc.htm", path) is False
    assert path.read_bytes() == b"<html/>" and len(fake.calls) == 1


def test_filings_from_block_keeps_only_the_exact_form() -> None:
    block = {
        "accessionNumber": ["a1", "a2", "a3"],
        "filingDate": ["2025-11-01", "2025-10-31", "2024-11-01"],
        "reportDate": ["2025-09-27", "2025-09-27", "2024-09-28"],
        "form": ["10-K/A", "10-K", "10-K"],
        "primaryDocument": ["x.htm", "y.htm", "z.htm"],
    }
    assert [f.accession for f in filings_from_block(block, "10-K")] == ["a2", "a3"]


def test_fiscal_year_prefers_dei_then_period_end() -> None:
    dei = (
        b'<ix:nonNumeric contextRef="c" name="dei:DocumentFiscalYearFocus">'
        b"2026</ix:nonNumeric>"
    )
    assert fiscal_year(dei, "2026-01-25") == 2026
    assert (
        fiscal_year(b"<html/>", "2026-01-25") == 2026
    )  # NVIDIA-style late-January year end
    assert (
        fiscal_year(b"<html/>", "2026-01-03") == 2025
    )  # 52/53-week year ending in early January
    assert fiscal_year(b"<html/>", "2025-12-31") == 2025
