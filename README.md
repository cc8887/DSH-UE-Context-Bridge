# UE Context Bridge

[简体中文](./README.zh-CN.md)

A context-efficient execution layer that lets a coding agent drive a live Unreal
Editor through a fixed surface of two or three tools instead of hundreds.

The editor's MCP plugin exposes a large tool library. Loading all of it into a
model's context is wasteful, and most of it is irrelevant to any single task.
This project keeps the tool library outside the model and gives it two
meta-tools: search for what you need, then call exactly that. It runs as a DSH
plugin with a local gateway subprocess that speaks MCP to the editor, so
approval, tool names and mode isolation stay under host control.

## Modes

A mode is fixed for the whole session; switching starts a new session.

| Mode | Model-visible tools | How it works |
| --- | --- | --- |
| `ue-deferred` | `ue_find`, `ue_call` | Build a local keyword index from toolset descriptions, retrieve relevant tools, dispatch through one fixed entry |
| `ue-python` | `ue_python_execute` | All discovery, execution, filtering and summarization happen inside the editor through one Python entry |

Both presets also expose `ue_env_check` and `ue_editor_status` / `ue_editor_start` / `ue_editor_stop`, which resolve the engine and drive the editor lifecycle without guessing paths.

## Quick start

Requires Node >= 20, Unreal Engine with the `ModelContextProtocol` plugin, and DSH.

```bash
node scripts/build-plugin.mjs
node scripts/deploy.mjs ue-bridge
dsh --profile ue-bridge "use ue_find to look up crash tools"
```

See [docs/setup.md](docs/setup.md) for the editor-side configuration, which
needs two non-obvious settings: `bAutoStartServer=True` (nothing listens without
it) and `bEnableToolSearch=False` (otherwise only three meta-tools are exposed).

## Repository layout

```text
packages/contracts/    shared model-tool, IPC and budget contracts
packages/dsh-plugin/   DSH plugin: tool registration, presets, approval, lifecycle
packages/gateway/      gateway subprocess: UE MCP client, catalog, ledger
ue/Content/Python/uex/ in-editor helper library
presets/               ue-deferred.yaml, ue-python.yaml, DSH profile bundle
fixtures/contracts/    recorded upstream responses per engine build
tests/unit/            unit tests
scripts/               build, deploy, probe and live-verification scripts
docs/                  setup, architecture, permissions, limitations
ue-project/            minimal UE project used to run the bridge
```

## Design constraints

The UE side is never modified. The upstream MCP plugin and the engine tree are
treated as read-only: Python mode reaches the editor through the engine's own
remote-execution protocol rather than by adding a UE plugin. The deferred index
is built from toolset descriptions because the top-level tool list only exposes
meta-tools.

Failures fail loudly. When a remote outcome cannot be confirmed, or a tool's
effect class is unknown, the call is refused rather than answered from guesswork.

## Status

Early stage, verified end-to-end on a single machine (Windows, UE `ue6-main`).
Effect classification, budget tuning and multi-editor coordination are still
open. The [limitations](docs/limitations.md) are part of the contract, not
disclaimers to be dropped once things work.

## License

[MIT](./LICENSE)
