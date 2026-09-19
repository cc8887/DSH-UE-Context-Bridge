# Architecture

```text
UE-specific DSH Agent
  ├─ ue-deferred preset: ue_find + ue_call
  └─ ue-python preset:   ue_python_execute
          |
          | native tool registration / approval / observation
          v
DSH plugin (packages/dsh-plugin)
          |
          | private local IPC, JSON-lines over a dedicated stdio
          | identity bound by the host, never supplied by the model
          v
Gateway (packages/gateway)
  ├─ upstream-mcp/   UE MCP client + version adapter
  ├─ catalog/        snapshot store + keyword retrieval
  ├─ policy/         effect classification + approval binding
  ├─ execution/      invocation ledger + single-editor write lock
  └─ results/        artifact store + byte budgets
          |
          | official MCP, using the editor-generated connection config
          v
Unreal Editor
  ├─ ModelContextProtocol + Toolsets
  └─ uex helper library (ue/Content/Python/uex)
```

## Why the gateway is a subprocess, not an MCP server

The plugin registers model tools directly. The gateway is a child process owned
by the plugin and acts only as a UE MCP client. In v0.1 it does not re-expose an
MCP server to the model. This keeps host approval, tool names, return structures
and mode isolation direct. A later cross-client release can add an MCP server
frontend sharing the same gateway core.

## Internal RPCs (not model tools)

```text
gateway.connect
gateway.health
catalog.search
catalog.describe
invocation.execute
invocation.status
artifact.read_page
```

Each RPC carries host-bound `session_id`, `project_id`, `editor_epoch` and a
call identity. The model never generates a trusted identity field.

## Why the deferred index is built from toolsets

When the top-level `tools/list` exposes only three meta-tools, the complete
per-tool index must be built from toolset descriptions. It cannot be guessed
from the top-level list.

Freshness is invalidated by editor restart, project switch, enabled-plugin
changes, missing toolsets and schema validation anomalies. An inner toolset
change is not assumed to trigger a top-level `tools/list_changed`.

## Known residual race

The whole UE tool library cannot be atomically locked. The source of freshness
and the remaining race window are recorded rather than presented as fully
eliminated TOCTOU.
