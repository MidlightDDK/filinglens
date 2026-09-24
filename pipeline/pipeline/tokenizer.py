"""Token counts from the embedding model's own tokenizer.

MODEL_ID and MODEL_REVISION must match the embedding model pinned in
packages/core/src/models.ts (M2), so `n_tokens` is what the embedder sees.
"""

from __future__ import annotations

import hashlib
import urllib.request
from pathlib import Path
from typing import Protocol

from tokenizers import Tokenizer

from pipeline.config import MODELS_DIR

MODEL_ID = "Xenova/bge-small-en-v1.5"
MODEL_REVISION = "ea104dacec62c0de699686887e3f920caeb4f3e3"
TOKENIZER_SHA256 = "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66"
TOKENIZER_URL = (
    f"https://huggingface.co/{MODEL_ID}/resolve/{MODEL_REVISION}/tokenizer.json"
)


class TokenCounter(Protocol):
    def offsets(self, text: str) -> list[tuple[int, int]]:
        """Character spans of the tokens in `text`, without special tokens."""
        ...

    def count(self, text: str) -> int: ...


class HfTokenizer:
    def __init__(self, tok: Tokenizer) -> None:
        tok.no_truncation()
        tok.no_padding()
        self._tok = tok

    def offsets(self, text: str) -> list[tuple[int, int]]:
        return self._tok.encode(text, add_special_tokens=False).offsets

    def count(self, text: str) -> int:
        return len(self._tok.encode(text, add_special_tokens=False).ids)


def load_tokenizer(path: Path | None = None) -> HfTokenizer:
    """Load the pinned tokenizer.json, downloading it once into data/models/."""
    path = (
        path
        or MODELS_DIR / MODEL_ID.replace("/", "--") / MODEL_REVISION / "tokenizer.json"
    )
    if not path.exists():
        with urllib.request.urlopen(TOKENIZER_URL, timeout=60) as resp:
            body = resp.read()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != TOKENIZER_SHA256:
        raise RuntimeError(
            f"{path} has sha256 {digest}, expected {TOKENIZER_SHA256}; "
            "delete it and rerun"
        )
    return HfTokenizer(Tokenizer.from_file(str(path)))
