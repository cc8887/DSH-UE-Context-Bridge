"""Verified in-process bindings.

Only bindings backed by a recorded P0 fixture are published. There is no
generic string-conversion rule and no fabricated reflection: an unknown mapping
is reported as unsupported rather than guessed.
"""

from __future__ import annotations

from typing import Any, Callable

Binding = Callable[[dict[str, Any]], Any]

_BINDINGS: dict[str, Binding] = {}


def register(tool_id: str, func: Binding) -> None:
    """Register a binding verified against a real fixture."""
    _BINDINGS[tool_id] = func


def resolve(tool_id: str) -> Binding | None:
    return _BINDINGS.get(tool_id)


def known_ids() -> list[str]:
    return sorted(_BINDINGS)
