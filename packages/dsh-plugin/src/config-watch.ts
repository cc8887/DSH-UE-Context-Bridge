/**
 * config-watch.ts — notice when the editor's config changes under us.
 *
 * dsh provisions bRemoteExecution and the multicast endpoint, but a user (or
 * the editor's own settings UI) can rewrite DefaultEngine.ini at any time.
 * When that happens our cached provisioning verdict goes stale, and dsh would
 * keep reporting an editor as ready or misconfigured based on an old read.
 *
 * Two ways to stay correct:
 *   - watch: react to edits as they happen
 *   - probe: re-check on a timer and immediately before key actions
 *
 * Both are used. Watching alone is unreliable across editors that save by
 * write-and-rename, and polling alone misses the moment of change.
 */

import { watch, type FSWatcher, type WatchEventType } from 'node:fs';
import { dirname, join } from 'node:path';
import { EditorRegistry, type EditorInstance } from './editor-registry.ts';

export type ConfigChangeKind = 'toggle' | 'endpoint' | 'removed';

export interface ConfigChange {
  projectRoot: string;
  projectName: string;
  kind: ConfigChangeKind;
  previous: EditorInstance['provisioned'];
  current: EditorInstance['provisioned'];
}

export interface ConfigWatcherOptions {
  /** Fallback re-check cadence when filesystem events are not delivered. */
  pollIntervalMs?: number;
  /** Called when a tracked project's config actually changes state. */
  onChange?: (change: ConfigChange) => void;
}

const DEFAULT_POLL_MS = 30_000;

/**
 * Tracks provisioning state for the projects dsh talks to.
 *
 * `refresh()` is cheap and synchronous, so it can be called right before a
 * python call without adding latency; the watcher exists to catch changes in
 * between.
 */
export class ConfigWatcher {
  private readonly registry: EditorRegistry;
  private readonly watched = new Map<string, { watcher: FSWatcher; instance: EditorInstance }>();
  private readonly options: Required<Pick<ConfigWatcherOptions, 'pollIntervalMs'>> &
    Pick<ConfigWatcherOptions, 'onChange'>;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(registry: EditorRegistry, options: ConfigWatcherOptions = {}) {
    this.registry = registry;
    this.options = {
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_MS,
      ...(options.onChange ? { onChange: options.onChange } : {}),
    };
  }

  /** Start tracking a project: watch now, and poll as a backstop. */
  async track(projectRoot: string, projectName?: string): Promise<EditorInstance> {
    const instance = await this.registry.register(projectRoot, projectName);
    if (this.watched.has(projectRoot) || this.closed) return instance;

    const iniPath = iniPathFor(projectRoot);
    try {
      // Watch the directory, not the file: editors that save by
      // write-temp-then-rename replace the inode, which silently ends a
      // watcher attached to the original file.
      const watcher = watch(dirOf(iniPath), (_event: WatchEventType, filename) => {
        if (filename && !filename.endsWith('.ini')) return;
        void this.refresh(projectRoot);
      });
      watcher.on('error', () => {
        // Fall back to polling only; closing here would drop the backstop too.
        this.watched.delete(projectRoot);
      });
      this.watched.set(projectRoot, { watcher, instance });
    } catch {
      // Unwatchable path (missing dir, permissions): polling still applies.
    }

    if (!this.timer && !this.closed) {
      this.timer = setInterval(() => this.refreshAll(), this.options.pollIntervalMs);
      this.timer.unref?.();
    }
    return instance;
  }

  /**
   * Re-read one project's config and report if the verdict changed.
   *
   * Safe to call immediately before a python call.
   */
  refresh(projectRoot: string): EditorInstance | undefined {
    const entry = this.watched.get(projectRoot);
    if (!entry) return this.registry.get(projectRoot);

    const previous = entry.instance.provisioned;
    const hadEndpoint = entry.instance.endpoint;
    const fresh = this.registry.recheck(projectRoot);
    if (!fresh) return undefined;

    if (fresh.provisioned !== previous) {
      entry.instance = fresh;
      this.options.onChange?.({
        projectRoot,
        projectName: fresh.projectName,
        kind: classify(previous, fresh.provisioned),
        previous,
        current: fresh.provisioned,
      });
    } else {
      entry.instance = fresh;
    }
    void hadEndpoint;
    return fresh;
  }

  /** Re-check everything tracked. Used by the polling backstop. */
  refreshAll(): void {
    for (const root of [...this.watched.keys()]) this.refresh(root);
  }

  /** Stop all watchers and timers. */
  close(): void {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const { watcher } of this.watched.values()) {
      try {
        watcher.close();
      } catch {
        // Already closed.
      }
    }
    this.watched.clear();
  }
}

function classify(previous: EditorInstance['provisioned'], current: EditorInstance['provisioned']): ConfigChangeKind {
  if (current === 'unprovisioned') return previous === 'config-file' ? 'endpoint' : 'removed';
  return 'toggle';
}

function iniPathFor(projectRoot: string): string {
  return join(projectRoot, 'Config', 'DefaultEngine.ini');
}

function dirOf(filePath: string): string {
  return dirname(filePath);
}
