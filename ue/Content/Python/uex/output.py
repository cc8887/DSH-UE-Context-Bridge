"""Bounded output helpers.

stdout, stderr and automatic tool logs are all independently bounded by the
gateway. Filtering and pagination happen at the data source first: trimming at
the model boundary reduces model input but does not undo the CPU, memory or
transport cost already spent inside the editor.
"""

from __future__ import annotations

from typing import Any

MAX_TEXT_CHARS = 4096
MAX_ITEMS = 20


def clip_text(text: str, limit: int = MAX_TEXT_CHARS) -> dict[str, Any]:
    clipped = len(text) > limit
    return {
        "text": text[:limit],
        "total_chars": len(text),
        "truncated": clipped,
    }
