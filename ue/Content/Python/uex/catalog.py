"""Catalog access for uex.

Tool definitions come from the gateway's versioned local snapshot. Native
Unreal Python API docs may be indexed from the project-generated
Intermediate/PythonStub/unreal.py, split per symbol and never sent whole to the
model. Stub files are parsed as text/AST only, never executed.
"""

from __future__ import annotations

from typing import Any

_SNAPSHOT_PATH_ENV = "UEX_CATALOG_SNAPSHOT"


def _load_snapshot() -> dict[str, Any]:
    import json
    import os

    path = os.environ.get(_SNAPSHOT_PATH_ENV)
    if not path:
        return {"coverage": "partial", "tools": [], "reason": "no snapshot configured"}
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def search(query: str, limit: int = 5) -> list[dict[str, Any]]:
    snapshot = _load_snapshot()
    tools = snapshot.get("tools", [])
    needle = query.lower()
    scored: list[tuple[int, dict[str, Any]]] = []
    for tool in tools:
        score = 0
        for field in ("id", "toolName", "toolsetName", "description"):
            value = str(tool.get(field, "")).lower()
            if needle in value:
                score += 10 if field in ("id", "toolName") else 3
        if score:
            scored.append((score, tool))
    scored.sort(key=lambda pair: (-pair[0], pair[1].get("id", "")))
    return [
        {
            "id": tool.get("id"),
            "toolsetName": tool.get("toolsetName"),
            "toolName": tool.get("toolName"),
            "description": str(tool.get("description", ""))[:240],
            "schemaRevision": tool.get("schemaRevision"),
            "effectClass": tool.get("effectClass"),
        }
        for _, tool in scored[:limit]
    ]


def describe(tool_id: str) -> dict[str, Any]:
    snapshot = _load_snapshot()
    for tool in snapshot.get("tools", []):
        if tool.get("id") == tool_id:
            return dict(tool)
    return {
        "id": tool_id,
        "complete": False,
        "error": "doc-unavailable",
        "coverage": snapshot.get("coverage", "partial"),
    }
