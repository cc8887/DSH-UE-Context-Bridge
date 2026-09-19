/**
 * tools.ts — the frozen model-facing tool set.
 *
 * Registration happens once, at agent init. Anything discovered later never
 * adds, removes, or reshapes a tool here (plan section 5.2 invariants 1-4).
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';
import {
  CALL_ACTIONS,
  UE_CALL,
  UE_FIND,
  UE_PYTHON_EXECUTE,
  UE_EDITOR_STATUS,
  UE_EDITOR_START,
  UE_EDITOR_STOP,
  UE_ENV_CHECK,
  retryPolicyForCode,
  type CallResponse,
  type ErrorEnvelope,
  type FindResponse,
  type PythonExecuteResponse,
  type UeErrorCode,
} from '@ue-bridge/contracts/model-tools';

/**
 * Python execution uses the engine's own remote-execution protocol, not an MCP
 * toolset: the UE MCP plugin exposes no Python surface, and dsh must not add
 * engine-side code. See ./remote-execution.ts.
 */
import { BUDGETS, boundJson } from '@ue-bridge/contracts/results';
import type { ConnectResult, HealthResult } from '@ue-bridge/contracts/ipc';
import { GatewayClient } from './ipc.ts';
import { PythonRemoteSession, RemoteExecutionError, DEFAULT_ENDPOINT } from './remote-execution.ts';
import { EditorRegistry, renderIniOverrides, renderIniSection } from './editor-registry.ts';
import { EditorSession, ensureReady } from './editor-lifecycle.ts';
import type { EngineResolution } from './toolchain.ts';
import { enumerateEngineInstallations, validateToolchain } from './toolchain.ts';
import {
  EngineSelectionStore,
  type EngineSelection,
} from './engine-selection.ts';
import { classifyPythonExecution, classifyStructuredCall, resolveDecision } from './approval.ts';
import type { PresetDefinition } from './presets.ts';

/** Host-bound identity: the model never produces these fields. */
export interface HostBinding {
  sessionId: string;
  projectId: string;
  editorEpoch: string;
  hostCallId(): string;
  /** False means high-privilege operations are denied, not silently allowed. */
  approvalChannelAvailable: boolean;
  /**
   * Project root, used to pick a per-instance endpoint. Optional because the
   * host may not know it yet; discovery then falls back to the stock endpoint.
   */
  projectRoot?: string;
  projectName?: string;
}

function fail(code: UeErrorCode, message: string, details?: Record<string, unknown>): never {
  const envelope: ErrorEnvelope = {
    code,
    message,
    retry: retryPolicyForCode(code),
    ...(details ? { details } : {}),
  };
  throw Object.assign(new Error(`${code}: ${message}`), { envelope });
}

/**
 * Can dsh use this engine without asking?
 *
 * The user's call was: resolve confidently and say so, ask only when genuinely
 * ambiguous. So "high confidence" is narrow and each case is justified:
 *
 *  - config / user-selection: someone stated the path outright.
 *  - association: the .uproject named an identifier that matched a real
 *    installed engine. UE would resolve to exactly this too.
 *  - association-path: the .uproject carried a path, resolved and verified
 *    against IsValidRootDirectory.
 *
 * `parent-directory` is deliberately NOT confident. It means the project never
 * said which engine; we merely found one above it. With multiple engines
 * installed that is a guess about intent, so it is reported but the user is
 * asked to confirm. That is the ambiguity case, and it is the only one.
 */
function isHighConfidence(engine: EngineResolution | undefined): boolean {
  if (!engine?.engineRoot) return false;
  if (engine.source === 'config' || engine.source === 'association' || engine.source === 'association-path') {
    // Even an explicitly stated engine is useless if UBT cannot run from it,
    // so the structural check gates confidence too.
    return engine.validRootDirectory && engine.buildBatFound;
  }
  return false;
}

/** Resolve a user's choice, which may be an identifier or an absolute path. */
function pickInstalled(
  choice: string,
  installed: Awaited<ReturnType<typeof enumerateEngineInstallations>>,
): Awaited<ReturnType<typeof enumerateEngineInstallations>>[number] | undefined {
  const normalized = choice.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return (
    installed.find((i) => i.identifier.toLowerCase() === choice.trim().toLowerCase()) ??
    installed.find((i) => i.root.toLowerCase() === normalized)
  );
}

/**
 * The payload shown when a project has no engine yet.
 *
 * Options are ordered so launcher releases come first, which is how UE itself
 * orders them. `awaiting` names this project so that when several editors are
 * in play it is unambiguous which one is being decided.
 */
async function decisionPayload(
  engine: EngineResolution | undefined,
  store: EngineSelectionStore,
  installedEngines: Array<Record<string, JsonValue>>,
  projectRoot: string,
): Promise<Record<string, JsonValue>> {
  const recorded = store.get(projectRoot);
  const decided: Record<string, JsonValue> = {};
  for (const [root, selection] of Object.entries(store.all())) {
    decided[root] = {
      engineRoot: selection.engineRoot,
      decidedAt: selection.decidedAt,
      ...(selection.identifier ? { identifier: selection.identifier } : {}),
    } as JsonValue;
  }
  return {
    engine: {
      source: recorded ? 'user-selection' : (engine?.source ?? 'unresolved'),
      ...(recorded ? { root: recorded.engineRoot } : {}),
      ...(engine?.engineRoot && !recorded ? { root: engine.engineRoot } : {}),
      ...(engine?.association ? { association: engine.association } : {}),
      ...(engine?.reason ? { reason: engine.reason } : {}),
      chosen: Boolean(recorded),
    },
    awaiting: projectRoot,
    options: installedEngines as unknown as JsonValue,
    /** Projects already decided, so a second editor is visibly still pending. */
    decided,
  };
}

/** Structural JSON value, matching what the tool boundary accepts. */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * dsh requires a plain JSON object return. Strip undefined and non-JSON values
 * so a typed response never fails serialization at the tool boundary.
 */
function toJson(value: unknown): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value ?? {})) as Record<string, JsonValue>;
}

export function registerDeferredTools(
  ctx: Context,
  preset: PresetDefinition,
  gateway: GatewayClient,
  host: HostBinding,
  mcpUrl: string,
): void {
  // False after a gateway restart, which leaves the catalog empty.
  let connected = false;
  ctx.tools.register(
    defineTool({
      name: UE_FIND,
      description:
        'Search the local Unreal Editor tool catalog. Returns bounded summaries, or one full definition when explicitly requested. Requires either "query" or "tool_ids".',
      parameters: {
        query: { type: 'string', description: 'Natural-language or keyword search text' },
        tool_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact tool ids to resolve; returns full definitions',
        },
        detail: {
          type: 'string',
          enum: ['summary', 'schema'],
          required: true,
          description: 'summary = short hits; schema = full parameter definition',
        },
        limit: { type: 'integer', description: 'Maximum hits (default 5)' },
        cursor: { type: 'string', description: 'Continuation cursor from a previous search' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (!args.query && !args.tool_ids) {
          fail('INVALID_ARGUMENTS', 'either "query" or "tool_ids" must be provided');
        }
        const identity = {
          session_id: host.sessionId,
          project_id: host.projectId,
          editor_epoch: host.editorEpoch,
          host_call_id: host.hostCallId(),
        };
        if (!connected) await ensureConnected(gateway, host, mcpUrl);
        connected = true;
        gateway.onRestart(() => {
          connected = false;
        });
        const result = await gateway.call<'catalog.search', FindResponse>(
          'catalog.search',
          {
            ...(args.query ? { query: args.query } : {}),
            ...(args.tool_ids ? { tool_ids: args.tool_ids } : {}),
            detail: args.detail,
            limit: args.limit ?? BUDGETS.SEARCH_CANDIDATES,
            ...(args.cursor ? { cursor: args.cursor } : {}),
          },
          {
            session_id: host.sessionId,
            project_id: host.projectId,
            editor_epoch: host.editorEpoch,
            host_call_id: host.hostCallId(),
          },
          exec.signal,
        );
        // Invariant 5: collapse before returning, never ship a large raw value.
        return toJson(boundJson(result, BUDGETS.FULL_DEFINITION_BYTES).value);
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: UE_CALL,
      description:
        'Invoke a discovered Unreal Editor tool, page through a large result, or query a run. The action set is fixed; use ue_find to discover tool ids first.',
      parameters: {
        action: {
          type: 'string',
          enum: [...CALL_ACTIONS],
          required: true,
          description: 'invoke = call a tool; read_result = page a result; run_status = query a run',
        },
        tool_id: { type: 'string', description: 'Tool id from ue_find (action=invoke)' },
        schema_revision: {
          type: 'string',
          description: 'Exact schema revision returned by ue_find (action=invoke)',
        },
        arguments: { type: 'json', description: 'Arguments object matching the discovered schema' },
        result_id: { type: 'string', description: 'Result id (action=read_result)' },
        run_id: { type: 'string', description: 'Run id (action=run_status)' },
        cursor: { type: 'string', description: 'Pagination cursor' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: (args) => args.action === 'read_result' || args.action === 'run_status',
      async execute(args, exec) {
        const identity = {
          session_id: host.sessionId,
          project_id: host.projectId,
          editor_epoch: host.editorEpoch,
          host_call_id: host.hostCallId(),
        };

        if (args.action === 'read_result') {
          if (!args.result_id) fail('INVALID_ARGUMENTS', 'result_id is required for read_result');
          return toJson(
            await gateway.call<'artifact.read_page', CallResponse>(
              'artifact.read_page',
              { result_id: args.result_id, ...(args.cursor ? { cursor: args.cursor } : {}) },
              identity,
              exec.signal,
            ),
          );
        }

        if (args.action === 'run_status') {
          if (!args.run_id) fail('INVALID_ARGUMENTS', 'run_id is required for run_status');
          return toJson(
            await gateway.call<'invocation.status', CallResponse>(
              'invocation.status',
              { run_id: args.run_id },
              identity,
              exec.signal,
            ),
          );
        }

        if (!args.tool_id) fail('INVALID_ARGUMENTS', 'tool_id is required for invoke');
        if (!args.schema_revision) {
          fail('INVALID_ARGUMENTS', 'schema_revision is required; take it from ue_find output');
        }
        if (args.arguments === undefined || args.arguments === null) {
          fail('INVALID_ARGUMENTS', 'arguments is required for invoke');
        }

        // Classify from the gateway's authoritative record, not from the model.
        const effect = await resolveEffectClass(gateway, args.tool_id, identity, exec.signal);
        const decision = resolveDecision(
          classifyStructuredCall(effect),
          host.approvalChannelAvailable,
        );
        if (decision === 'deny') {
          fail('APPROVAL_REQUIRED', `effect class "${effect}" needs an approval channel`);
        }

        return toJson(
          await gateway.call<'invocation.execute', CallResponse>(
            'invocation.execute',
            {
              tool_id: args.tool_id,
              schema_revision: args.schema_revision,
              arguments: args.arguments as Record<string, unknown>,
              effect_class: effect,
            },
            identity,
            exec.signal,
          ),
        );
      },
    }),
  );

  void preset;
}

export function registerPythonTool(
  ctx: Context,
  preset: PresetDefinition,
  _gateway: GatewayClient,
  host: HostBinding,
): void {
  // dsh owns the endpoint choice: one multicast port per editor instance, so
  // several editors can run at once. A dsh restart re-derives the same port
  // from the project path, keeping an existing config valid.
  let session: PythonRemoteSession | null = null;

  /**
   * Re-read the project config before acting on it.
   *
   * The user can edit DefaultEngine.ini (or the editor can rewrite it) after
   * we last looked, so a cached provisioning verdict may be stale. This is the
   * "check right before the key event" half of config monitoring.
   */
  async function recheckConfig(binding: HostBinding) {
    const registry = new EditorRegistry();
    const instance = await registry.register(binding.projectRoot!, binding.projectName);
    return registry.recheck(binding.projectRoot!) ?? instance;
  }

  async function withSession(): Promise<PythonRemoteSession> {
    if (session) return session;
    // Without a project root there is nothing to key a per-instance port on,
    // so fall back to the stock endpoint rather than inventing one.
    const endpoint = host.projectRoot
      ? (await recheckConfig(host)).endpoint
      : DEFAULT_ENDPOINT;
    const next = new PythonRemoteSession(endpoint);
    try {
      await next.discover();
    } catch (error) {
      await next.close().catch(() => undefined);
      throw error;
    }
    session = next;
    return next;
  }

  ctx.tools.register(
    defineTool({
      name: UE_PYTHON_EXECUTE,
      description:
        'Execute Python inside the Unreal Editor. All UE capability discovery, filtering and batching happen in this single entry point. "description" is for human review only.',
      parameters: {
        code: { type: 'string', required: true, description: 'Python source to run in the editor' },
        description: {
          type: 'string',
          required: true,
          description: 'Short human-readable summary of what the program does',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        // Python is always reviewed in v0.1; description is not a permission claim.
        const decision = resolveDecision(
          classifyPythonExecution({ code: args.code, description: args.description }),
          host.approvalChannelAvailable,
        );
        if (decision === 'deny') {
          fail('APPROVAL_REQUIRED', 'python execution requires an approval channel');
        }
        const identity = {
          session_id: host.sessionId,
          project_id: host.projectId,
          editor_epoch: host.editorEpoch,
          host_call_id: host.hostCallId(),
        };
        void identity;

        let remote: PythonRemoteSession;
        try {
          remote = await withSession();
        } catch (error) {
          const code = error instanceof RemoteExecutionError ? error.code : 'CONNECTION_FAILED';
          if (!host.projectRoot) {
            fail('EDITOR_UNAVAILABLE', 'no Unreal Editor reachable for python execution', {
              reason: code,
              expected_endpoint: `${DEFAULT_ENDPOINT.multicastGroup}:${DEFAULT_ENDPOINT.port}`,
              hint: 'project root unknown; using the stock endpoint. is the editor running with bRemoteExecution=True?',
            });
          }
          const instance = await recheckConfig(host);
          fail('EDITOR_UNAVAILABLE', 'no Unreal Editor reachable for python execution', {
            reason: code,
            expected_endpoint: `${instance.endpoint.multicastGroup}:${instance.endpoint.port}`,
            provisioning: instance.provisioned,
            hint:
              instance.provisioned === 'config-file'
                ? 'config already matches this endpoint; is the editor running?'
                : 'start the editor with these flags (or write them into Config/DefaultEngine.ini)',
            command_line: renderIniOverrides(instance),
            ini_section: renderIniSection(instance),
          });
        }

        try {
          const run = await remote.run(args.code);
          return toJson(
            boundJson(
              {
                ok: run.success,
                stdout: run.stdout,
                log: run.output,
                ...(run.success ? {} : { error: run.stdout || 'python execution failed' }),
              },
              BUDGETS.RESULT_BYTES,
            ).value,
          );
        } catch (error) {
          const code = error instanceof RemoteExecutionError ? error.code : 'EXECUTION_FAILED';
          // A dead channel is retryable: drop the session so the next call
          // reconnects instead of reusing a broken socket.
          if (code === 'TIMEOUT' || code === 'CONNECTION_FAILED') {
            await session?.close().catch(() => undefined);
            session = null;
          }
          // A timeout leaves the editor's state unknown: never auto-replay.
          fail('REMOTE_OUTCOME_UNKNOWN', 'python execution did not complete', { reason: code });
        }
      },
    }),
  );

  void preset;
}

/**
 * Register the three editor lifecycle tools.
 *
 * State lives in the EditorSession owned by the plugin, not in the model's
 * context: the model observes, dsh remembers. Every failure is returned, not
 * thrown, so the model always gets an actionable record.
 */
export function registerEditorTools(
  ctx: Context,
  session: EditorSession,
  selectionStore?: EngineSelectionStore,
): void {
  ctx.tools.register(
    defineTool({
      name: UE_EDITOR_STATUS,
      description:
        'Read the current Unreal Editor state: phase, endpoint, provisioning, and the last build or crash if any. Use this to check whether the editor is usable before running engine tools, and to read errors after a failed start.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => true,
      async execute() {
        const snap = session.snapshot();
        return toJson({
          phase: snap.phase,
          alive: session.alive,
          project: snap.projectName,
          pid: snap.pid,
          endpoint: `${snap.endpoint.multicastGroup}:${snap.endpoint.port}`,
          provisioned: snap.provisioned,
          // Running is not the same as usable: without provisioning the editor
          // is up but dsh cannot reach it, and the model would otherwise see a
          // success it cannot act on.
          usable: snap.phase === 'running' && session.alive,
          remote_ready: snap.provisioned !== 'unprovisioned',
          ...(snap.engine
            ? {
                engine: {
                  // How dsh found this engine: the project's own
                  // EngineAssociation, or an explicit engineRoot.
                  source: snap.engine.source,
                  ...(snap.engine.engineRoot ? { root: snap.engine.engineRoot } : {}),
                  ...(snap.engine.association ? { association: snap.engine.association } : {}),
                  build_bat_found: snap.engine.buildBatFound,
                  ...(snap.engine.reason ? { reason: snap.engine.reason } : {}),
                },
              }
            : {}),
          ...(snap.phase !== 'stopped' && snap.provisioned === 'unprovisioned'
            ? {
                warning:
                  'editor is running but remote execution is not configured; engine tools will not connect. Check Config/DefaultEngine.ini bRemoteExecution.',
              }
            : {}),
          ...(snap.lastBuild
            ? {
                last_build: {
                  ok: snap.lastBuild.ok,
                  exit_code: snap.lastBuild.exitCode,
                  up_to_date: snap.lastBuild.upToDate,
                  compiled: snap.lastBuild.ok && !snap.lastBuild.upToDate,
                  // 'cache' means UBT was not re-run: sources are unchanged.
                  verdict_source: snap.lastBuild.source,
                  duration_ms: snap.lastBuild.durationMs,
                  errors: snap.lastBuild.errors.slice(0, 20).map((e) => ({
                    severity: e.severity,
                    code: e.code,
                    location: `${e.file}:${e.line}:${e.column}`,
                    message: e.message,
                  })),
                  ...(snap.lastBuild.ok ? {} : { raw_tail: snap.lastBuild.rawTail.slice(-15) }),
                },
              }
            : {}),
          ...(snap.lastCrash
            ? {
                last_crash: {
                  at: snap.lastCrash.detectedAt,
                  exit_code: snap.lastCrash.exitCode,
                  ...(snap.lastCrash.crashDir ? { crash_dir: snap.lastCrash.crashDir } : {}),
                  summary: snap.lastCrash.summary.slice(-20),
                },
              }
            : {}),
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: UE_EDITOR_START,
      description:
        'Make the Unreal Editor usable. dsh decides whether that requires compiling first or just launching, performs it, and returns the outcome including any build errors or crash. Set force_build to recompile even when binaries exist.',
      parameters: {
        force_build: {
          type: 'boolean',
          description: 'Recompile before launching even if binaries already exist',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        const startedAt = Date.now();
        try {
          const outcome = await ensureReady(session, {
            forceBuild: args.force_build === true,
          });
          return toJson({
            ok: outcome.action !== 'build_failed' && outcome.action !== 'launch_failed',
            action: outcome.action,
            built: outcome.built,
            duration_ms: Date.now() - startedAt,
            ...(outcome.build
              ? {
                  build: {
                    ok: outcome.build.ok,
                    exit_code: outcome.build.exitCode,
                    // UBT's verdict: was a compile actually needed and run?
                    up_to_date: outcome.build.upToDate,
                    compiled: outcome.built && outcome.build.ok && !outcome.build.upToDate,
                    verdict_source: outcome.build.source,
                    duration_ms: outcome.build.durationMs,
                    error_count: outcome.build.errors.length,
                    warning_count: outcome.build.warnings.length,
                    errors: outcome.build.errors.slice(0, 20).map((e) => ({
                      severity: e.severity,
                      code: e.code,
                      location: `${e.file}:${e.line}:${e.column}`,
                      message: e.message,
                    })),
                    ...(outcome.build.ok ? {} : { raw_tail: outcome.build.rawTail.slice(-15) }),
                  },
                }
              : {}),
            state: {
              phase: outcome.state.phase,
              pid: outcome.state.pid,
              endpoint: `${outcome.state.endpoint.multicastGroup}:${outcome.state.endpoint.port}`,
              provisioned: outcome.state.provisioned,
              remote_ready: outcome.state.provisioned !== 'unprovisioned',
            },
            ...(outcome.state.phase !== 'stopped' &&
            outcome.state.provisioned === 'unprovisioned'
              ? {
                  warning:
                    'editor launched but remote execution is not configured; engine tools will not connect until bRemoteExecution is enabled.',
                }
              : {}),
            ...(outcome.note ? { note: outcome.note } : {}),
          });
        } catch (error) {
          // Returned, not thrown: the model must still get the state to act on.
          return toJson({
            ok: false,
            action: 'launch_failed',
            built: false,
            duration_ms: Date.now() - startedAt,
            ...{ note: error instanceof Error ? error.message : String(error) },
            state: {
              phase: session.phase,
              pid: null,
              provisioned: session.snapshot().provisioned,
            },
          });
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: UE_ENV_CHECK,
      description:
        'Check whether this project can build: which engine it targets and how that was resolved, plus UBT’s own verdict on the Windows toolchain. Also lists every UE engine installed on this machine (launcher releases and registered source builds) with its version, using Unreal’s own discovery. Use this first when a build fails for reasons that are not source errors, to confirm the environment before starting, or to find which engine versions are available.',
      parameters: {
        platform: { type: 'string', description: 'Platform to validate, defaults to Win64' },
        /**
         * Choosing an engine is the user's call, so it is an explicit action
         * rather than something dsh infers. `selection` records it permanently;
         * the choice is never revisited unless asked again or reset.
         */
        selection: {
          type: 'string',
          description:
            'Set the engine for this project. Pass an identifier from installed_engines (e.g. "5.6") or an absolute engine root. Persisted; only needed once.',
        },
        confirm: {
          type: 'string',
          description:
            'Confirm an engine that is already resolved, recording it so the source of the choice is explicit rather than inferred.',
        },
        reset: {
          type: 'boolean',
          description:
            'Forget the recorded engine for this project, so the next check asks again. Use when a project should move to a different engine.',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const platform = typeof args.platform === 'string' ? args.platform : 'Win64';
        const snap = session.snapshot();
        const projectRoot = snap.projectRoot ?? session.projectRoot;

        // Every engine UE itself would offer, using its own discovery. This is
        // what makes "which engine should I use" answerable rather than guessed.
        const installed = await enumerateEngineInstallations();
        const installedEngines = installed.map((i) => ({
          identifier: i.identifier,
          root: i.root,
          via: i.via,
          ...(i.version ? { version: i.version } : {}),
          ...(i.sourceDistribution ? { source_distribution: true } : {}),
        }));

        // Recorded choices live in the host store, not in the session, so they
        // survive restarts and are shared by every editor on this machine.
        const store = selectionStore ?? new EngineSelectionStore();

        // reset: forget the choice so the next check re-decides.
        if (args.reset === true) {
          store.clear(projectRoot);
          const fresh = await session.resolveEngineNow(undefined, projectRoot);
          const decision = await decisionPayload(fresh, store, installedEngines, projectRoot);
          return toJson({
            ok: false,
            can_build: false,
            platform,
            ...decision,
            ...{ note: 'Recorded engine cleared. The next check will resolve or ask again.' },
          });
        }

        // selection: the user picked one. Accept an identifier or a path.
        const choice = typeof args.selection === 'string' ? args.selection : undefined;
        if (choice) {
          const chosen = pickInstalled(choice, installed);
          if (!chosen) {
            const known = installedEngines.map((e) => e.identifier).join(', ');
            return toJson({
              ok: false,
              can_build: false,
              platform,
              ...(await decisionPayload(
                await session.resolveEngineNow(undefined, projectRoot),
                store,
                installedEngines,
                projectRoot,
              )),
              ...{
                note: `No installed engine matches "${choice}". Known identifiers: ${known || '(none)'}. Pass one of those, or an absolute engine root.`,
              },
            });
          }
          const applied = await session.resolveEngineNow(chosen.root, projectRoot);
          store.set(projectRoot, {
            ...(chosen.identifier ? { identifier: chosen.identifier } : {}),
            engineRoot: chosen.root,
            decidedAt: new Date().toISOString(),
            ...(chosen.version ? { version: chosen.version } : {}),
          });
          const toolchain = await validateToolchain(chosen.root, platform);
          return toJson({
            ok: toolchain.valid,
            can_build: toolchain.valid && applied.buildBatFound,
            platform,
            engine: {
              source: 'user-selection',
              root: chosen.root,
              ...(chosen.identifier ? { identifier: chosen.identifier } : {}),
              ...(chosen.version ? { version: chosen.version } : {}),
              build_bat_found: applied.buildBatFound,
            },
            ...{ note: `Engine recorded for this project at ${store.file}. It will be reused; ask the user before changing it.` },
          });
        }

        // confirm: record whatever is in effect, so a confidently resolved
        // engine can be made permanent without re-entering it.
        if (typeof args.confirm === 'string' || args.confirm === true) {
          const engine = snap.engine;
          if (engine?.engineRoot) {
            store.set(projectRoot, {
              ...(engine.identifier ? { identifier: engine.identifier } : {}),
              engineRoot: engine.engineRoot,
              decidedAt: new Date().toISOString(),
              ...(engine.engineVersion ? { version: engine.engineVersion } : {}),
            });
            const toolchain = await validateToolchain(engine.engineRoot, platform);
            return toJson({
              ok: toolchain.valid,
              can_build: toolchain.valid && engine.buildBatFound,
              platform,
              engine: {
                source: 'user-selection',
                root: engine.engineRoot,
                ...(engine.identifier ? { identifier: engine.identifier } : {}),
                ...(engine.engineVersion ? { version: engine.engineVersion } : {}),
                build_bat_found: engine.buildBatFound,
                recorded: true,
              },
              ...{
                note: `Recorded ${engine.identifier ?? engine.engineRoot} for this project at ${store.file}. ` +
                  `It will be reused; use reset=true before changing it.`,
              },
            });
          }
        }

        let engine = snap.engine;
        // Re-read: confirm may have just written, and the decision below must
        // see that rather than the value captured before it.
        const recorded = store.get(projectRoot);

        // A recorded choice is authoritative: the user decided once, and dsh
        // does not re-decide. It stays until reset or until it stops pointing
        // at a real engine.
        if (recorded) {
          const stillThere = installed.find((i) => i.root.toLowerCase() === recorded.engineRoot.toLowerCase());
          if (!stillThere) {
            // The engine vanished. Surface that instead of silently rebuilding
            // against something else, but keep the record for reference.
            const decision = await decisionPayload(engine, store, installedEngines, projectRoot);
            return toJson({
              ok: false,
              can_build: false,
              platform,
              ...decision,
              ...{
                note:
                  `The recorded engine is no longer installed: ${recorded.engineRoot}. ` +
                  `Ask the user whether to choose another (options above) or restore that path.`,
              },
            });
          }
          engine = await session.resolveEngineNow(stillThere.root, projectRoot);
        }

        // The user's rule: resolve confidently and report it, ask only when
        // genuinely ambiguous. So a confident resolution is used immediately
        // and stated; only a real ambiguity stops to ask.
        if (!recorded) {
          if (isHighConfidence(engine)) {
            const root = engine!.engineRoot!;
            const toolchain = await validateToolchain(root, platform);
            return toJson({
              ok: toolchain.valid,
              can_build: toolchain.valid && engine!.buildBatFound,
              platform: toolchain.platform,
              engine: {
                // 'resolved' rather than 'user-selection': nothing was chosen
                // by the user, it was confidently derived and is being reported.
                source: 'resolved',
                resolved_via: engine!.source,
                root,
                ...(engine!.association ? { association: engine!.association } : {}),
                ...(engine!.identifier ? { identifier: engine!.identifier } : {}),
                ...(engine!.engineVersion ? { version: engine!.engineVersion } : {}),
                ...(engine!.sourceDistribution !== undefined
                  ? { source_distribution: engine!.sourceDistribution }
                  : {}),
                ...(engine!.native !== undefined ? { native: engine!.native } : {}),
                build_bat_found: engine!.buildBatFound,
                /** Not persisted: an inferred engine must not become permanent. */
                recorded: false,
              },
              toolchain: {
                valid: toolchain.valid,
                ...(toolchain.sdk ? { sdk: toolchain.sdk } : {}),
                ...(toolchain.raw ? { ubt_line: toolchain.raw } : {}),
                ...(toolchain.error ? { error: toolchain.error } : {}),
              },
              ...{
                note:
                  `Using ${engine!.identifier ?? root} for this project, resolved from the .uproject (${engine!.source}); ` +
                  `no choice was recorded, so it may still be confirmed with confirm=true. ` +
                  `Alternatives: ${installedEngines.map((e) => e.identifier).join(', ')}.`,
              },
            });
          }

          // Genuine ambiguity: either nothing resolved, or the only resolution
          // was an engine merely found above the project, which says nothing
          // about intent. Ask, per project, and wait.
          const decision = await decisionPayload(engine, store, installedEngines, projectRoot);
          const inferred = engine?.source === 'parent-directory';
          return toJson({
            ok: false,
            can_build: false,
            platform,
            ...decision,
            ...{
              note: inferred
                ? `No EngineAssociation in the .uproject; an engine was found above it at ${engine!.engineRoot}, ` +
                  `but which engine this project means is ambiguous. Ask the user to choose from options ` +
                  `and call again with selection=<identifier>. The choice is saved and reused.`
                : 'No engine chosen for this project yet. Ask the user to choose from options ' +
                  `and call again with selection=<identifier>. The choice is saved and reused.`,
            },
          });
        }

        const chosenRoot: string | undefined = engine?.engineRoot;
        if (!chosenRoot) {
          return toJson({
            ok: false,
            can_build: false,
            platform,
            ...(await decisionPayload(engine, store, installedEngines, projectRoot)),
            ...{ note: 'No engine resolved; choose one from options.' },
          });
        }
        const chosenEngine: EngineResolution = engine as EngineResolution;
        const toolchain = await validateToolchain(chosenRoot, platform);
        return toJson({
            ok: toolchain.valid,
            can_build: toolchain.valid && chosenEngine.buildBatFound,
          platform: toolchain.platform,
          engine: {
            source: chosenEngine.source,
            root: chosenRoot,
            ...(chosenEngine.association ? { association: chosenEngine.association } : {}),
            ...(chosenEngine.identifier ? { identifier: chosenEngine.identifier } : {}),
            ...(chosenEngine.engineVersion ? { version: chosenEngine.engineVersion } : {}),
            ...(chosenEngine.sourceDistribution !== undefined
              ? { source_distribution: chosenEngine.sourceDistribution }
              : {}),
            ...(chosenEngine.native !== undefined ? { native: chosenEngine.native } : {}),
            build_bat_found: chosenEngine.buildBatFound,
          },
          installed_engines: installedEngines,
          toolchain: {
            valid: toolchain.valid,
            ...(toolchain.sdk ? { sdk: toolchain.sdk } : {}),
            ...(toolchain.raw ? { ubt_line: toolchain.raw } : {}),
            ...(toolchain.error ? { error: toolchain.error } : {}),
          },
          ...(toolchain.valid
            ? {}
            : {
                note: "UBT reports this platform cannot build. This is an environment problem, not a source error: check the required MSVC/Windows SDK versions. UBT's message: " +
                  (toolchain.error ?? toolchain.raw ?? 'none'),
              }),
        });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: UE_EDITOR_STOP,
      description:
        'Shut down the Unreal Editor dsh started. Waits for a clean exit and escalates to a forced kill if it does not respond.',
      parameters: {
        force: { type: 'boolean', description: 'Skip the graceful wait and kill immediately' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        const wasAlive = session.alive;
        try {
          await session.stop(args.force === true);
          return toJson({
            ok: true,
            was_running: wasAlive,
            phase: session.phase,
            ...(session.snapshot().lastCrash
              ? { note: 'editor exited; a crash report was recorded' }
              : {}),
          });
        } catch (error) {
          return toJson({
            ok: false,
            was_running: wasAlive,
            phase: session.phase,
            ...{ note: error instanceof Error ? error.message : String(error) },
          });
        }
      },
    }),
  );
}

async function resolveEffectClass(
  gateway: GatewayClient,
  toolId: string,
  identity: {
    session_id: string;
    project_id: string;
    editor_epoch: string;
    host_call_id: string;
  },
  signal?: AbortSignal,
) {
  const described = await gateway.call<
    'catalog.describe',
    { effectClass: CallResponse extends never ? never : 'verified_read' | 'write' | 'privileged' | 'unknown' }
  >('catalog.describe', { tool_id: toolId }, identity, signal);
  return described.effectClass;
}

export async function ensureConnected(
  gateway: GatewayClient,
  host: HostBinding,
  mcpUrl: string,
): Promise<ConnectResult> {
  return gateway.call<'gateway.connect', ConnectResult>(
    'gateway.connect',
    { mcp_entry: { transport: 'http', url: mcpUrl } },
    {
      session_id: host.sessionId,
      project_id: host.projectId,
      editor_epoch: host.editorEpoch,
      host_call_id: host.hostCallId(),
    },
  );
}

export async function probeHealth(gateway: GatewayClient, host: HostBinding): Promise<HealthResult> {
  return gateway.call<'gateway.health', HealthResult>(
    'gateway.health',
    {},
    {
      session_id: host.sessionId,
      project_id: host.projectId,
      editor_epoch: host.editorEpoch,
      host_call_id: host.hostCallId(),
    },
  );
}
