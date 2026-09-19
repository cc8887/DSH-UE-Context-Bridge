/**
 * build-freshness.ts — remember UBT's "is a compile needed?" verdict.
 *
 * Asking UBT is authoritative (it weighs action command lines, dependency
 * lists and produced-file sizes), but it costs a few seconds every time even
 * when nothing changed. With a sub-second `start` that overhead dominates.
 *
 * So the verdict is cached and invalidated by the two things that can change
 * it:
 *   - a source file actually changing (filesystem watch, plus a polling
 *     backstop because watching alone misses write-and-rename saves)
 *   - a build running, which is itself the most accurate invalidation signal
 *
 * Deliberately narrow: only a successful build is cached. A failed build
 * means UBT did not reach a verdict, so caching it would report "no compile
 * needed" for a project that may not even compile.
 */

import { existsSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

/** Extensions whose change can make a C++ target dirty. */
const SOURCE_EXTENSIONS = ['.cpp', '.h', '.hpp', '.c', '.cc', '.cxx', '.inl', '.cs', '.build.cs'];

export interface BuildFreshnessOptions {
  /** How long a cached verdict stays usable without re-asking UBT. */
  maxAgeMs?: number;
  /** Fallback scan cadence when filesystem events are not delivered. */
  pollIntervalMs?: number;
  /** Source roots to watch. Defaults to <projectRoot>/Source. */
  sourceRoots?: string[];
}

interface CachedVerdict {
  upToDate: boolean;
  at: number;
  /** Highest source mtime seen when the verdict was recorded. */
  newestSourceMtime: number;
}

const DEFAULT_MAX_AGE_MS = 120_000;
const DEFAULT_POLL_MS = 5_000;

/**
 * Caches UBT's up-to-date verdict for one project.
 *
 * `check()` answers from cache when possible, otherwise reports a miss and
 * lets the caller ask UBT, feeding the answer back through `record()`.
 */
export class BuildFreshness {
  private readonly options: Required<Pick<BuildFreshnessOptions, 'maxAgeMs' | 'pollIntervalMs'>> &
    Pick<BuildFreshnessOptions, 'sourceRoots'>;
  private cache: CachedVerdict | null = null;
  private readonly watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  /** Bumped whenever sources may have changed, to invalidate stale verdicts. */
  private revision = 0;
  private revisionAtCache = -1;

  constructor(
    private readonly projectRoot: string,
    options: BuildFreshnessOptions = {},
  ) {
    this.options = {
      maxAgeMs: options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_MS,
      ...(options.sourceRoots ? { sourceRoots: options.sourceRoots } : {}),
    };
  }

  /** Begin watching source roots. Safe to call more than once. */
  watchSources(): void {
    if (this.closed) return;
    const roots = this.options.sourceRoots ?? [join(this.projectRoot, 'Source')];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      try {
        // recursive: true keeps this to one watcher per root; on Windows a
        // non-recursive watch misses nested module directories.
        const watcher = watch(root, { recursive: true }, (_event, filename) => {
          if (filename && !isSourceFile(filename)) return;
          this.invalidate();
        });
        watcher.on('error', () => {
          // Fall back to the polling backstop; do not tear down tracking.
        });
        this.watchers.push(watcher);
      } catch {
        // Unwatchable root: polling still applies.
      }
    }

    if (!this.timer && !this.closed) {
      this.timer = setInterval(() => this.reconcile(), this.options.pollIntervalMs);
      this.timer.unref?.();
    }
  }

  /**
   * Read the cached verdict.
   *
   * Returns undefined on a miss, meaning the caller should ask UBT.
   */
  check(): { upToDate: boolean; age: number } | undefined {
    if (!this.cache) return undefined;
    if (this.revision !== this.revisionAtCache) return undefined;
    const age = Date.now() - this.cache.at;
    if (age > this.options.maxAgeMs) return undefined;
    // Sources may have changed while we were not watching (editor opened and
    // closed between polls, external generator, branch switch).
    if (this.newestSourceMtime() > this.cache.newestSourceMtime) return undefined;
    return { upToDate: this.cache.upToDate, age };
  }

  /** Record UBT's verdict. Only successful runs are worth caching. */
  record(upToDate: boolean): void {
    this.cache = {
      upToDate,
      at: Date.now(),
      newestSourceMtime: this.newestSourceMtime(),
    };
    this.revisionAtCache = this.revision;
  }

  /** Drop the cached verdict because inputs may have changed. */
  invalidate(): void {
    this.revision += 1;
  }

  /**
   * Reconcile against the filesystem. Used by the polling backstop: a missed
   * event shows up as a newer mtime than the one recorded with the verdict.
   */
  reconcile(): void {
    if (!this.cache) return;
    if (this.newestSourceMtime() > this.cache.newestSourceMtime) this.invalidate();
  }

  private newestSourceMtime(): number {
    let newest = 0;
    for (const root of this.options.sourceRoots ?? [join(this.projectRoot, 'Source')]) {
      newest = Math.max(newest, newestMtimeUnder(root));
    }
    return newest;
  }

  /** Stop watchers and timers. */
  close(): void {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
        // Already closed.
      }
    }
    this.watchers.length = 0;
    this.cache = null;
  }
}

function isSourceFile(name: string): boolean {
  const lower = name.toLowerCase();
  return SOURCE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    // Raced with a delete or is locked; treat as "no useful time".
    return 0;
  }
}

function newestMtimeUnder(root: string): number {
  let newest = 0;
  if (!existsSync(root)) return newest;
  try {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!isSourceFile(entry.name)) continue;
        const mtime = mtimeOf(full);
        if (mtime > newest) newest = mtime;
      }
    }
  } catch {
    // Unreadable tree: return what we have.
  }
  return newest;
}
