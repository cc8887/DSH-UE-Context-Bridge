"""Editor-side execution records.

A run may succeed while persistence or verification is still unproven. These
are three separate facts; no single boolean or natural-language claim is
accepted as proof.
"""

from __future__ import annotations

from typing import Any

_RECORDS: dict[str, dict[str, Any]] = {}


def record(run_id: str, **fields: Any) -> dict[str, Any]:
    entry = _RECORDS.setdefault(run_id, {"run_id": run_id})
    entry.update(fields)
    return dict(entry)


def status(run_id: str) -> dict[str, Any]:
    entry = _RECORDS.get(run_id)
    if entry is None:
        return {
            "run_id": run_id,
            "execution": "unknown",
            "verification": "not_run",
            "persistence": "not_checked",
            "found": False,
        }
    return dict(entry)


def read_page(result_id: str, cursor: str | None = None) -> dict[str, Any]:
    entry = _RECORDS.get(result_id)
    if entry is None:
        return {"result_id": result_id, "error": "RESULT_EXPIRED", "items": []}
    pages = entry.get("pages", [])
    index = int(cursor) if cursor else 0
    return {
        "result_id": result_id,
        "items": pages[index : index + 1],
        "next_cursor": str(index + 1) if index + 1 < len(pages) else None,
        "complete": index + 1 >= len(pages),
    }
