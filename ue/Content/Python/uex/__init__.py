"""uex — small helper library available inside Unreal Editor Python.

These are in-process functions, NOT registered DSH or MCP top-level tools.
Only these six short signatures belong in the fixed bootstrap; the full UE
class list is never injected.

Every binding used by uex.call must come from a verified fixture. When a
binding is unavailable this module fails loudly instead of guessing a name
conversion.
"""

from __future__ import annotations

from typing import Any

__version__ = "0.1.0"

_MAX_EMIT_ITEMS = 20


class BindingUnavailable(RuntimeError):
    """Raised when no verified in-process binding covers the requested tool."""


def find(query: str, limit: int = 5) -> list[dict[str, Any]]:
    """Search the gateway's local catalog snapshot."""
    from uex import catalog

    return catalog.search(query, limit=limit)


def describe(tool_id: str) -> dict[str, Any]:
    """Return one tool's parameter definition from the local snapshot."""
    from uex import catalog

    return catalog.describe(tool_id)


def call(tool_id: str, arguments: dict[str, Any]) -> Any:
    """Invoke a discovered tool through a verified in-process binding.

    This never performs a synchronous HTTP call back to the editor's own MCP
    endpoint, which would risk a wait cycle or reentrancy problem.
    """
    from uex import bindings

    binding = bindings.resolve(tool_id)
    if binding is None:
        raise BindingUnavailable(
            f"no verified binding for {tool_id!r}; "
            "run the P0 binding probe before use"
        )
    return binding(arguments)


def emit(value: Any, *, max_items: int = _MAX_EMIT_ITEMS) -> dict[str, Any]:
    """Produce a bounded structured result. Loop and filter before emitting."""
    if isinstance(value, (list, tuple)):
        items = list(value[:max_items])
        return {
            "items": items,
            "total": len(value),
            "returned": len(items),
            "truncated": len(value) > max_items,
        }
    if isinstance(value, dict):
        keys = list(value.keys())[:max_items]
        return {
            "items": {k: value[k] for k in keys},
            "total": len(value),
            "returned": len(keys),
            "truncated": len(value) > max_items,
        }
    return {"items": value, "total": 1, "returned": 1, "truncated": False}


def read_result(result_id: str, cursor: str | None = None) -> dict[str, Any]:
    """Read one page of a full result. Never appends the whole log."""
    from uex import execution_records

    return execution_records.read_page(result_id, cursor)


def run_status(run_id: str) -> dict[str, Any]:
    """Query an editor-side run record. Cannot unblock a stuck editor."""
    from uex import execution_records

    return execution_records.status(run_id)
