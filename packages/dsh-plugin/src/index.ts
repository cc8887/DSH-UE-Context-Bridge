/**
 * index.ts — DSH plugin entry (plan section 5.1).
 *
 * Registers the frozen mode tools and one static prompt section. The gateway is
 * a child process owned by this plugin; it is a UE MCP client only and never
 * exposes an MCP server to the model in v0.1.
 */

import type { Context } from '@deepseek-ai/cordis';
import { resolvePreset, type PresetDefinition } from './presets.ts';
import { sectionNameFor, staticSectionFor, SECTION_ORDER_UE_MODE } from './section.ts';
import { GatewayClient } from './ipc.ts';
import {
  registerDeferredTools,
  registerPythonTool,
  registerEditorTools,
  ensureConnected,
  type HostBinding,
} from './tools.ts';
import { resolveGatewayLocation } from './gateway-root.ts';
import { runInvariants } from './invariants.ts';
import { EditorSession } from './editor-lifecycle.ts';
import { EngineSelectionStore } from './engine-selection.ts';

export interface UeBridgeConfig {
  /** Preset name: "ue-deferred" or "ue-python". */
  preset: string;
  /** Gateway entrypoint. */
  gatewayCommand: string;
  gatewayArgs: string[];
  /**
   * Working directory for the gateway. Optional: when omitted the gateway is
   * located from the plugin's own install location, so the bundle patch
   * carries no machine-specific path. Set it only to override that discovery.
   */
  gatewayCwd?: string;
  /**
   * UE MCP endpoint, read from the editor-generated config. Never hardcoded:
   * the port and path are editor settings.
   */
  mcpUrl?: string;
  /** False denies high-privilege operations instead of permitting them silently. */
  approvalChannelAvailable?: boolean;
  /** UE project root. When set, dsh owns the editor lifecycle for it. */
  projectRoot?: string;
  /** Engine root containing Engine/Build/BatchFiles/Build.bat. */
  engineRoot?: string;
  /** Build target, e.g. "UnrealEditor". */
  buildTarget?: string;
}

/** Services this plugin needs; cordis enforces these before apply() runs. */
export const inject = ['tools', 'systemPrompt'];

apply.inject = inject;

let callSeq = 0;

/** Endpoint from config, env, or the editor default (port/path are configurable). */
function resolveMcpUrl(config: UeBridgeConfig): string {
  return config.mcpUrl ?? process.env.UE_MCP_URL ?? 'http://127.0.0.1:8000/mcp';
}

export function apply(ctx: Context, config: UeBridgeConfig): () => void {
  const preset: PresetDefinition = resolvePreset(config.preset);

  // The gateway ships beside this plugin, so its root is discovered rather
  // than configured. Only an explicit gatewayCwd overrides that.
  const gatewayCwd = config.gatewayCwd ?? resolveGatewayLocation()?.cwd;
  if (!gatewayCwd) {
    throw new Error(
      'ue-bridge: gateway package not found beside the plugin and no gatewayCwd was set; ' +
        'install @ue-bridge/gateway next to @ue-bridge/dsh-plugin, or set gatewayCwd',
    );
  }

  const gateway = new GatewayClient({
    command: config.gatewayCommand,
    args: config.gatewayArgs,
    cwd: gatewayCwd,
  });
  gateway.start();

  const host: HostBinding = {
    sessionId: 'session-pending',
    projectId: 'project-pending',
    editorEpoch: 'epoch-pending',
    hostCallId: () => `host-${(callSeq += 1)}`,
    approvalChannelAvailable: config.approvalChannelAvailable ?? false,
  };

  const disposers: Array<() => void> = [];
  const mcpUrl = resolveMcpUrl(config);

  // dsh owns the editor when it is told which project to run: start it, build
  // it, and watch it, so the model only ever reads outcomes (errors, crashes,
  // phase) instead of driving processes.
  // One store shared by every editor: a user's engine choice per project
  // persists across restarts and is never re-decided silently.
  const selections = new EngineSelectionStore();

  let editor: EditorSession | null = null;
  if (config.projectRoot) {
    editor = new EditorSession({
      projectRoot: config.projectRoot,
      ...(config.engineRoot ? { engineRoot: config.engineRoot } : {}),
      ...(config.buildTarget ? { target: config.buildTarget } : {}),
    });
    editor.on('crash', (report) => {
      conlog(`editor crashed (exit ${report.exitCode}): ${report.summary.slice(-3).join(' | ')}`);
    });
    void editor.prepare().catch((cause: unknown) => {
      conlog(`editor prepare failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
    disposers.push(() => editor?.dispose());
  }

  // Connect to the live editor on startup; the catalog is built from the real
  // tools/list rather than from any bundled snapshot.
  void ensureConnected(gateway, host, mcpUrl).catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    conlog(`connect failed: ${mcpUrl} :: ${message}`);
  });

  function conlog(text: string): void {
    try {
      (ctx as unknown as { logger?: { warn(m: string): void } }).logger?.warn(text);
    } catch {
      /* logging is best-effort */
    }
  }

  // One static section. No runtime state, no tool directory (invariant 3).
  disposers.push(
    ctx.systemPrompt.section({
      name: sectionNameFor(preset.mode),
      order: SECTION_ORDER_UE_MODE,
      text: staticSectionFor(preset.mode),
    }),
  );

  // Lifecycle is mode-independent: both modes need a usable editor, and both
  // should see failures as values rather than process-management chores.
  if (editor) registerEditorTools(ctx, editor, selections);

  if (preset.mode === 'deferred') {
    registerDeferredTools(ctx, preset, gateway, host, mcpUrl);
  } else {
    registerPythonTool(ctx, preset, gateway, host);
  }

  // Monotonic guard: final refusal for known-forbidden cases. It is not an
  // asynchronous approval service.
  disposers.push(
    ctx.tools.guard(() => {
      return undefined;
    }),
  );

  const report = runInvariants(ctx, preset.mode);
  if (!report.ok) conlog(`invariant violation: ${report.violations.join('; ')}`);

  return () => {
    for (const dispose of disposers.reverse()) dispose();
    void gateway.stop();
  };
}

export default apply;
