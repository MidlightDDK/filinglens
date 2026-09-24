"""SEC EDGAR client: User-Agent, <= 5 requests/second, retry with backoff, file cache.

Fair-access policy: https://www.sec.gov/os/accessing-edgar-data
"""

from __future__ import annotations

import gzip
import json
import logging
import os
import time
import urllib.error
import urllib.request
import zlib
from collections.abc import Callable
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/{name}"
ARCHIVE_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{accession}/{document}"

RETRY_STATUSES = {429, 500, 502, 503, 504}

# (url, headers) -> (status, body, response headers)
Fetch = Callable[[str, dict[str, str]], tuple[int, bytes, dict[str, str]]]


class SecError(RuntimeError):
    pass


def _urllib_fetch(
    url: str, headers: dict[str, str]
) -> tuple[int, bytes, dict[str, str]]:
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read(), dict(resp.headers.items())
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers.items())


def _decode(body: bytes, headers: dict[str, str]) -> bytes:
    enc = {k.lower(): v for k, v in headers.items()}.get("content-encoding", "").lower()
    if enc == "gzip":
        return gzip.decompress(body)
    if enc == "deflate":
        return zlib.decompress(body)
    return body


class SecClient:
    def __init__(
        self,
        user_agent: str | None = None,
        *,
        min_interval: float = 0.2,
        max_retries: int = 5,
        fetch: Fetch = _urllib_fetch,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        ua = (
            user_agent
            if user_agent is not None
            else os.environ.get("SEC_USER_AGENT", "")
        ).strip()
        if not ua:
            raise SecError(
                'SEC_USER_AGENT is not set. Set it to "Full Name email@example.com" '
                "(SEC fair-access policy) and rerun."
            )
        self._headers = {"User-Agent": ua, "Accept-Encoding": "gzip, deflate"}
        self._min_interval = min_interval
        self._max_retries = max_retries
        self._fetch = fetch
        self._sleep = sleep
        self._clock = clock
        self._last: float | None = None

    def _throttle(self) -> None:
        if self._last is not None:
            wait = self._last + self._min_interval - self._clock()
            if wait > 0:
                self._sleep(wait)
        self._last = self._clock()

    def get(self, url: str) -> bytes:
        for attempt in range(self._max_retries + 1):
            self._throttle()
            try:
                status, body, headers = self._fetch(url, self._headers)
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                status, body, headers, reason = 0, b"", {}, f"network error: {e}"
            else:
                reason = f"HTTP {status}"
            if status == 200:
                return _decode(body, headers)
            if status and status not in RETRY_STATUSES:
                raise SecError(f"{reason} for {url}")
            if attempt == self._max_retries:
                raise SecError(f"{reason} for {url} after {attempt + 1} attempts")
            retry_after = {k.lower(): v for k, v in headers.items()}.get(
                "retry-after", ""
            )
            delay = (
                float(retry_after) if retry_after.isdigit() else min(2.0**attempt, 60.0)
            )
            log.warning("%s for %s; retrying in %.0fs", reason, url, delay)
            self._sleep(delay)
        raise AssertionError("unreachable")

    def get_json(self, url: str) -> Any:
        return json.loads(self.get(url))

    def download(self, url: str, path: Path, *, refresh: bool = False) -> bool:
        """Download to `path` unless it is already cached. Returns True if fetched."""
        if path.exists() and not refresh:
            return False
        body = self.get(url)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".part")
        tmp.write_bytes(body)
        tmp.replace(path)
        return True
