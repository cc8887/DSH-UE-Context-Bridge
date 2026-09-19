/**
 * editor-registry.ts — dsh-side model of the editors it talks to.
 *
 * dsh owns the Python remote-execution settings rather than leaving them
 * scattered across per-project ini files. Each editor instance gets its own
 * multicast endpoint, so multiple editors can run side by side instead of all
 * contending for 239.0.0.1:6766.
 *
 * The engine side stays untouched: these are stock UPythonScriptPluginSettings
 * values that dsh writes into the project config before launch, or passes as
 * `-ini:` overrides.
 */

import getPort, { portNumbers, clearLockedPorts } from 'get-port';
import dgram from 'node:dgram';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Endpoint dsh assigns to one editor instance. */
export interface EditorEndpoint {
  multicastGroup: string;
  port: number;
  bindAddress: string;
}

export interface EditorInstance {
  /** Stable dsh-side handle, distinct from the engine's runtime node id. */
  id: string;
  projectRoot: string;
  projectName: string;
  endpoint: EditorEndpoint;
  /** How the settings reached the editor. */
  provisioned: 'config-file' | 'command-line' | 'unprovisioned';
}

export interface RegistryOptions {
  /** First port in the range dsh hands out. */
  portRangeStart?: number;
  portRangeEnd?: number;
  multicastGroup?: string;
  bindAddress?: string;
}

const DEFAULTS = {
  portRangeStart: 6770,
  portRangeEnd: 6790,
  multicastGroup: '239.0.0.1',
  bindAddress: '127.0.0.1',
};

/**
 * Assigns and remembers an endpoint per editor instance.
 *
 * Ports are allocated deterministically from the project path so a restart of
 * dsh or the editor lands on the same port, which keeps an already-provisioned
 * config valid instead of silently drifting.
 */
export class EditorRegistry {
  private readonly instances = new Map<string, EditorInstance>();
  private readonly options: typeof DEFAULTS;

  constructor(options: RegistryOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Register (or re-resolve) an editor rooted at `projectRoot`. */
  async register(projectRoot: string, projectName?: string): Promise<EditorInstance> {
    const existing = this.instances.get(projectRoot);
    if (existing) return existing;

    const instance = await this.build(projectRoot, projectName);
    this.instances.set(projectRoot, instance);
    return instance;
  }

  /** Build the instance record, choosing an endpoint for this project. */
  private async build(projectRoot: string, projectName?: string): Promise<EditorInstance> {
    const { multicastGroup, bindAddress } = this.options;

    // The config is the source of truth while an editor is running: it names
    // the port that editor actually joined. Reusing it keeps an in-flight
    // editor reachable; picking a "free" port instead would strand it.
    //
    // Note the port will usually test as "in use" -- by that very editor. That
    // is expected, not a conflict, so only another dsh-managed project can
    // veto it.
    const declared = readConfiguredPort(projectRoot);
    if (declared !== undefined && !this.heldByOtherProject(projectRoot, declared)) {
      return this.finish(projectRoot, projectName, { multicastGroup, port: declared, bindAddress });
    }

    const port = await this.allocatePort(projectRoot);
    return this.finish(projectRoot, projectName, { multicastGroup, port, bindAddress });
  }

  private finish(
    projectRoot: string,
    projectName: string | undefined,
    endpoint: EditorEndpoint,
  ): EditorInstance {
    return {
      id: `${projectName ?? this.deriveProjectName(projectRoot)}-${endpoint.port}`,
      projectRoot,
      projectName: projectName ?? this.deriveProjectName(projectRoot),
      endpoint,
      provisioned: detectProvisioning(projectRoot, endpoint),
    };
  }

  /** True when another dsh-managed project already owns `port`. */
  private heldByOtherProject(projectRoot: string, port: number): boolean {
    for (const other of this.instances.values()) {
      if (other.projectRoot !== projectRoot && other.endpoint.port === port) return true;
    }
    return false;
  }

  /**
   * Re-read this project's config and return a refreshed instance.
   *
   * Unlike `register`, this does not reuse the cached verdict, so it reflects
   * edits made since the first read.
   */
  recheck(projectRoot: string): EditorInstance | undefined {
    const existing = this.instances.get(projectRoot);
    if (!existing) return undefined;
    const refreshed: EditorInstance = {
      ...existing,
      provisioned: detectProvisioning(projectRoot, existing.endpoint),
    };
    this.instances.set(projectRoot, refreshed);
    return refreshed;
  }

  get(projectRoot: string): EditorInstance | undefined {
    return this.instances.get(projectRoot);
  }

  list(): EditorInstance[] {
    return [...this.instances.values()];
  }

  /**
   * Find a port no other editor is using.
   *
   * `get-port` owns candidate selection and in-process locking, which removes
   * the collision handling we would otherwise maintain by hand. Because it
   * only checks TCP, each candidate is confirmed free over UDP before use.
   *
   * Deterministic from the project path: a dsh restart lands on the same port,
   * keeping an already-provisioned config valid.
   */
  private async allocatePort(projectRoot: string): Promise<number> {
    const { portRangeStart, portRangeEnd, bindAddress } = this.options;
    const span = Math.max(portRangeEnd - portRangeStart, 0);
    const preferred = preferredPort(projectRoot, portRangeStart, portRangeEnd);
    const taken = new Set([...this.instances.values()].map((i) => i.endpoint.port));

    const candidates: number[] = [preferred];
    for (let offset = 1; offset <= span; offset += 1) {
      const port = portRangeStart + ((preferred - portRangeStart + offset) % (span + 1));
      if (port !== preferred) candidates.push(port);
    }

    for (const candidate of candidates) {
      if (taken.has(candidate)) continue;
      if (!(await isUdpPortFree(candidate, bindAddress))) continue;
      try {
        // reserve: hold the port for this process so concurrent registrations
        // in the same dsh session cannot land on it.
        const port = await getPort({ port: candidate, host: bindAddress, reserve: true });
        if (await isUdpPortFree(port, bindAddress)) return port;
      } catch {
        // Candidate unusable (in use, locked, or reserved); try the next.
      }
    }

    // Range exhausted: let the library pick anything free rather than reusing
    // a port and breaking a running editor.
    try {
      return await getPort({ port: portNumbers(portRangeStart, portRangeEnd), host: bindAddress, reserve: true });
    } catch {
      return preferred;
    }
  }

  private deriveProjectName(projectRoot: string): string {
    const parts = projectRoot.replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts[parts.length - 1] || 'editor';
  }
}

/**
 * The port the project's config already declares, if any.
 *
 * Read before allocating: while an editor is running this is the port it
 * actually joined, so it must win over any fresh allocation.
 */
function readConfiguredPort(projectRoot: string): number | undefined {
  const iniPath = join(projectRoot, 'Config', 'DefaultEngine.ini');
  if (!existsSync(iniPath)) return undefined;
  const match = /RemoteExecutionMulticastGroupEndpoint\s*=\s*[^:]*:(\d+)/i.exec(readFileSync(iniPath, 'utf8'));
  if (!match) return undefined;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

/**
 * Check whether the project config already carries dsh's settings.
 *
 * `unprovisioned` means dsh must supply them (config write or `-ini:`) before
 * Python mode can work; it never means dsh edits engine source.
 */
function detectProvisioning(projectRoot: string, endpoint: EditorEndpoint): EditorInstance['provisioned'] {
  const iniPath = join(projectRoot, 'Config', 'DefaultEngine.ini');
  if (!existsSync(iniPath)) return 'unprovisioned';
  const text = readFileSync(iniPath, 'utf8');
  const hasToggle = /^\s*bRemoteExecution\s*=\s*True\s*$/im.test(text);
  const expected = `${endpoint.multicastGroup}:${endpoint.port}`;
  const hasEndpoint = text.includes(expected);
  return hasToggle && hasEndpoint ? 'config-file' : 'unprovisioned';
}

/**
 * The port this project should get when nothing else has claimed it.
 *
 * Derived from the path so the choice survives a dsh restart.
 */
function preferredPort(projectRoot: string, start: number, end: number): number {
  const span = Math.max(end - start, 0);
  let hash = 0;
  for (let i = 0; i < projectRoot.length; i += 1) {
    hash = (hash * 31 + projectRoot.charCodeAt(i)) >>> 0;
  }
  return start + (hash % (span + 1));
}

export { clearLockedPorts };

/**
 * Is this UDP port actually bindable?
 *
 * `get-port` only probes TCP (it uses net.createServer internally), so it will
 * happily hand back a port an editor already holds as UDP. The remote-execution
 * channel is UDP multicast, so this is the check that actually matters.
 */
export async function isUdpPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    // No reuseAddr: we want the bind to fail if anything already holds the
    // port, which is exactly the collision signal we are testing for.
    const sock = dgram.createSocket({ type: 'udp4' });
    let settled = false;
    const done = (free: boolean) => {
      if (settled) return;
      settled = true;
      try {
        sock.close();
      } catch {
        // Already closed.
      }
      resolve(free);
    };
    sock.once('error', () => done(false));
    sock.bind(port, host, () => done(true));
  });
}

/**
 * The ini lines dsh wants present for `instance`.
 */
export function renderIniSection(instance: EditorInstance): string {
  return [
    '[/Script/PythonScriptPlugin.PythonScriptPluginSettings]',
    'bRemoteExecution=True',
    `RemoteExecutionMulticastGroupEndpoint=${instance.endpoint.multicastGroup}:${instance.endpoint.port}`,
    `RemoteExecutionMulticastBindAddress=${instance.endpoint.bindAddress}`,
    '',
  ].join('\n');
}

/**
 * Command-line form used to launch an editor without touching its config.
 *
 * Preferred when the user does not want project files modified.
 */
export function renderIniOverrides(instance: EditorInstance): string[] {
  const section = '[/Script/PythonScriptPlugin.PythonScriptPluginSettings]';
  return [
    `-ini:Engine:${section}bRemoteExecution=True`,
    `-ini:Engine:${section}RemoteExecutionMulticastGroupEndpoint=${instance.endpoint.multicastGroup}:${instance.endpoint.port}`,
    `-ini:Engine:${section}RemoteExecutionMulticastBindAddress=${instance.endpoint.bindAddress}`,
  ];
}
