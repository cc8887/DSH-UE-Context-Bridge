# Permissions

## Classification source

The read/write class of a structured call comes from adapter rules or manual
review. It is never derived from:

- the tool's name (containing `get` or `list` proves nothing),
- the model's self-report,
- an unverified MCP annotation.

Unknown defaults to requiring approval (plan section 6.6).

## Structured calls

| effect class | decision |
|---|---|
| `verified_read` | allowed without per-call confirmation |
| `write` | approval |
| `privileged` | approval |
| `unknown` | approval |

## Python

Every script is reviewed before execution, including imports, loops and any
`unreal.*` call. There is deliberately no `read_only=true` parameter: it would
pretend to constrain Python permissions while providing no enforcement.

A later opt-in trusted development mode may reduce approval frequency. It does
not increase sandbox security.

## Approval binding

An approval is bound to:

- the actual code or argument digest,
- `project_id`,
- `editor_epoch`,
- `schema_revision`,
- the adapter/config version.

If any of these change, the approval is void. An approval is never
reinterpreted as authorization for a different operation.

## No approval channel

When no approval channel is available, high-privilege operations are **denied**,
not silently permitted (plan section 5.2 invariant 7).

## What is not a sandbox

For arbitrary Python, a declared target scope is a statement for human review,
not an unavoidable file or UObject access boundary. Path allowlists, AST linting
and monkey patching do not together constitute a strong sandbox for arbitrary
Python.
