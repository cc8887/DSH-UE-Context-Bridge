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

For installing from a release artifact instead of a clone, see
[One-command install](#one-command-install).

See [docs/setup.md](docs/setup.md) for the editor-side configuration, which
needs two non-obvious settings: `bAutoStartServer=True` (nothing listens without
it) and `bEnableToolSearch=False` (otherwise only three meta-tools are exposed).

## One-command install

Install into a DSH profile from the release artifact, without cloning the repo:

```bash
dsh plugin --profile ue-bridge add \
  https://github.com/cc8887/DSH-UE-Context-Bridge/releases/download/v0.1.0/ue-bridge-bundle-0.1.0.tgz
node "<profile-dir>/node_modules/@ue-bridge/bundle/install.mjs" --profile ue-bridge
```

where `<profile-dir>` is the profile directory dsh reports for `--profile
ue-bridge` (by default `~/.dsh/profiles/ue-bridge`). On Windows the same line
works in PowerShell with `%USERPROFILE%\.dsh\profiles\ue-bridge`, and the script
also resolves `DSH_HOME` when that is set.

The first step unpacks the bundle and registers it as a profile layer. The
second moves the compiled packages out of `packages/` into
`node_modules/@ue-bridge/*`, where Node resolves them. Restart the profile once
afterwards so the new layer is loaded.

See [docs/setup.md](docs/setup.md) for the editor-side configuration, which
needs two non-obvious settings: `bAutoStartServer=True` (nothing listens without
it) and `bEnableToolSearch=False` (otherwise only three meta-tools are exposed).

## Why this instead of wiring UE MCP in directly

The editor's MCP plugin is the right transport. What it does not solve is what
happens when a model is handed the whole tool library at once. These are the
specific things this bridge does about it, and each one points at the code that
implements it.

**The tool surface stays at two or three.** Model-facing shapes are frozen at
registration and never vary with catalog contents, project or engine build, so
the tool prefix a client sees is stable across sessions. Everything else stays
behind `ue_find`.

**Discovery is local and deterministic.** `ue_find` scores the catalog inside
the gateway, weighting exact tool id, then method name, then toolset, then
keyword. There is no LLM query rewrite and no extra model call per search, so
retrieval costs no tokens beyond the query and the hits.

**The engine and the editor are resolved, not guessed.** Which engine a project
builds against is a human decision: it is asked once per project, remembered by
project root, and never silently switched. A confident resolution is used and
reported, and only an ambiguous one asks again. Lifecycle tools take an intent
(get the editor usable) instead of one tool per operation, so "start" can mean
build, launch or both without the model knowing which.

**Approval and identity stay with the host.** The gateway is a child process
acting as a UE MCP client, not another MCP server in the model's path, so tool
names, return shapes and mode isolation remain host-controlled. Call identity is
bound by the host and the model never supplies a trusted identity field. Effect
class comes from adapter rules or manual review, never from a tool's name, a
model's self-report, or an unverified MCP annotation. An approval is bound to
the argument digest, project, editor epoch and adapter version, so it cannot be
reused for a different operation, and with no approval channel a privileged call
is refused rather than allowed by default.

**Failure is a first-class answer.** Execution, verification and persistence are
reported as three separate facts, so "the call returned" is never presented as
"the asset was saved". Every error carries an explicit retry policy. A write
that landed in an unknown state is never auto-replayed, and the single-editor
write lock is not released merely because a client timed out.

**Large results collapse instead of flooding context.** An oversized payload is
reduced to a small canonical value carrying the byte count and a `result_id`;
full content is read back through the artifact store with a cursor. That is real
pagination rather than a text tail cut, and truncation is always reported.

**Nothing is added to the UE side.** The upstream MCP plugin and the engine tree
are treated as read-only. Python mode reaches the editor through the engine's
own remote-execution protocol rather than by adding a plugin, so upgrading the
engine or switching projects leaves no patch to re-apply and no forked plugin to
maintain.

Each claim above is implemented somewhere specific, so it can be checked rather
than taken on trust:

| Claim | Where |
| --- | --- |
| Frozen model-facing shapes | [model-tools.ts](packages/contracts/src/model-tools.ts) |
| Local deterministic scoring | [catalog.ts](packages/gateway/src/catalog/catalog.ts) |
| Engine decided once per project | [engine-selection.ts](packages/dsh-plugin/src/engine-selection.ts) |
| Host-bound identity, effect class, approval digest | [approval.ts](packages/dsh-plugin/src/approval.ts) |
| Execution / verification / persistence as separate facts, retry policy | [model-tools.ts](packages/contracts/src/model-tools.ts) |
| Write lock held through unknown outcomes | [ledger.ts](packages/gateway/src/execution/ledger.ts) |
| Byte budgets and cursor pagination | [results.ts](packages/contracts/src/results.ts) |

Each of these has a boundary, and the boundaries are part of the contract in
[docs/limitations.md](docs/limitations.md). A stable prefix improves the
conditions for cache reuse without guaranteeing a server-side hit. One Python
tool is not a smaller permission set and is not a sandbox. Trimming results
locally does not reduce UE-side memory or transport cost.

## Repository layout

```text
packages/bundle/      DSH profile bundle: declares dsh.bundle.patch, installed via `dsh plugin add`
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
