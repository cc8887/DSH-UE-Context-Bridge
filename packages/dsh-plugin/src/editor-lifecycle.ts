/**
 * editor-lifecycle.ts — model the editor as a state machine dsh controls.
 *
 * Today dsh only *observes* an editor that the user happened to start. That
 * forces the model to ask the user to build, to watch for crashes, and to
 * guess whether the editor it is talking to is the one from the last command.
 *
 * The goal is that the model sees only outcomes: "build failed with these
 * errors", "editor crashed with this stack", "editor is idle". So dsh owns
 * launching, building, and watching, and exposes a single state object.
 *
 * States:
 *   stopped -> starting -> running -(build)-> building -> running
 *                                 \-(crash)-> crashed
 *   any terminal/ambient state -> stopped
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EditorRegistry, type EditorInstance } from './editor-registry.ts';
import { ConfigWatcher } from './config-watch.ts';
import { BuildFreshness } from './build-freshness.ts';
import { resolveEngineRoot, type EngineResolution } from './toolchain.ts';

export type EditorPhase = 'stopped' | 'starting' | 'running' | 'building' | 'crashed' | 'stopping';

export interface BuildError {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface BuildResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  errors: BuildError[];
  warnings: BuildError[];
  /**
   * True when UBT reported "Target is up to date", meaning it ran no compile
   * actions. This is UBT's own verdict, not an inference.
   */
  upToDate: boolean;
  /**
   * Whether this verdict came from asking UBT, or from a cached verdict whose
   * inputs we know have not changed. The model should not care; it exists so
   * a suspicious latency drop can be explained rather than distrusted.
   */
  source: 'ubt' | 'cache';
  /** Tail of raw output, for messages the parser did not classify. */
  rawTail: string[];
}

/**
 * Outcome of a "make the editor usable" request.
 *
 * `action` tells the model what dsh decided and did, so it never has to infer
 * whether a build happened.
 */
export interface StartOutcome {
  action: 'already_running' | 'launched' | 'built_and_launched' | 'build_failed' | 'launch_failed';
  built: boolean;
  build?: BuildResult;
  state: EditorStateSnapshot;
  /** Human-readable note when something went wrong or needed a decision. */
  note?: string;
}

export interface CrashReport {
  detectedAt: string;
  exitCode: number | null;
  signal: string | null;
  /** Most recent crash directory, if the engine wrote one. */
  crashDir?: string;
  /** Lines that look like a callstack or assertion, newest last. */
  summary: string[];
  logPath?: string;
}

export interface EditorStateSnapshot {
  projectRoot: string;
  projectName: string;
  phase: EditorPhase;
  pid: number | null;
  endpoint: EditorInstance['endpoint'];
  provisioned: EditorInstance['provisioned'];
  /**
   * Which engine this project builds against, and how that was decided.
   * Present after prepare(); a wrong engine is visible here before any build.
   */
  engine?: EngineResolution;
  lastBuild?: BuildResult;
  lastCrash?: CrashReport;
  startedAt?: string;
}

export interface EditorSessionOptions {
  projectRoot: string;
  projectName?: string;
  /** Engine root containing Engine/Build/BatchFiles/Build.bat. */
  engineRoot?: string;
  /** Build target, e.g. "UnrealEditor". Defaults to UnrealEditor. */
  target?: string;
  platform?: string;
  configuration?: string;
  /** Extra args for the editor process. */
  extraArgs?: string[];
}



/**
 * Owns one editor instance: start, build, watch for death, collect diagnostics.
 *
 * Emits 'phase', 'build', and 'crash'. The model reads snapshots; it does not
 * manage processes.
 */
export class EditorSession extends EventEmitter {
  readonly options: Omit<
    Required<Pick<EditorSessionOptions, 'target' | 'platform' | 'configuration' | 'extraArgs'>>,
    'engineRoot'
  > &
    Pick<EditorSessionOptions, 'engineRoot'> &
    EditorSessionOptions;

  private readonly registry: EditorRegistry;
  private readonly watcher: ConfigWatcher;
  /** Caches UBT's up-to-date verdict so repeated starts stay cheap. */
  private readonly freshness: BuildFreshness;
  /** How the engine root was determined; set by prepare(). */
  private engine: EngineResolution | undefined;
  private child: ChildProcess | null = null;
  private phaseValue: EditorPhase = 'stopped';
  private instance: EditorInstance | null = null;
  private lastBuild: BuildResult | undefined;
  private lastCrash: CrashReport | undefined;
  private startedAt: string | undefined;
  private logPath: string | undefined;

  constructor(options: EditorSessionOptions, registry = new EditorRegistry(), watcher?: ConfigWatcher) {
    super();
    this.options = {
      target: options.target ?? 'UnrealEditor',
      platform: options.platform ?? 'Win64',
      configuration: options.configuration ?? 'Development',
      engineRoot: options.engineRoot ?? '',
      extraArgs: [],
      ...options,
    };
    this.registry = registry;
    this.freshness = new BuildFreshness(this.options.projectRoot);
    this.watcher =
      watcher ??
      new ConfigWatcher(registry, {
        onChange: () => {
          const current = this.registry.get(this.options.projectRoot);
          if (current) this.instance = current;
        },
      });
  }

  get phase(): EditorPhase {
    return this.phaseValue;
  }

  private setPhase(next: EditorPhase): void {
    if (this.phaseValue === next) return;
    this.phaseValue = next;
    this.emit('phase', next);
  }

  /** Register with the registry, resolve endpoint, and begin watching config. */
  async prepare(): Promise<EditorInstance> {
    this.instance = await this.watcher.track(this.options.projectRoot, this.options.projectName);
    // Start watching before the first build, so an edit made while that build
    // runs is not missed.
    this.freshness.watchSources();
    // Resolve the engine before anything needs it, so a mis-resolved engine
    // is reported as a clear status rather than as a confusing build error.
    await this.resolveEngine();
    return this.instance;
  }

  /**
   * Re-resolve the engine, optionally against a root the user just chose.
   *
   * The engine is a user decision that can change at any time, so resolution
   * cannot happen only once in prepare().
   */
  async resolveEngineNow(explicit?: string, projectRoot?: string): Promise<EngineResolution> {
    if (projectRoot && projectRoot !== this.options.projectRoot) {
      (this.options as { projectRoot?: string }).projectRoot = projectRoot;
    }
    if (explicit !== undefined) {
      (this.options as { engineRoot?: string }).engineRoot = explicit;
    }
    return this.resolveEngine();
  }

  /** The project root this session owns. */
  get projectRoot(): string {
    return this.options.projectRoot;
  }

  /**
   * Work out which engine this project builds against.
   *
   * Uses the project's own EngineAssociation, the same key the editor uses,
   * rather than assuming a path. Exposed via snapshot() so a wrong engine is
   * visible before a build is attempted.
   */
  private async resolveEngine(): Promise<EngineResolution> {
    const uprojectPath = this.findUproject();
    let descriptor: { EngineAssociation?: string } | undefined;
    if (uprojectPath) {
      try {
        descriptor = JSON.parse(readFileSync(uprojectPath, 'utf8')) as { EngineAssociation?: string };
      } catch {
        // Unreadable descriptor: fall through, resolution reports why.
      }
    }
    this.engine = await resolveEngineRoot(
      this.options.projectRoot,
      descriptor,
      this.options.engineRoot,
      uprojectPath,
    );
    // An explicitly configured root is authoritative even if resolution
    // disagrees; otherwise adopt what the project asked for.
    if (!this.options.engineRoot && this.engine.engineRoot) {
      (this.options as { engineRoot?: string }).engineRoot = this.engine.engineRoot;
    }
    return this.engine;
  }

  /** Is an editor process we spawned still alive? */
  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  /**
   * Build the project's editor target.
   *
   * Parses UBT's `file(line,col): error C####:` form into structured entries so
   * the model gets a table rather than a wall of text.
   */
  async build(opts: { force?: boolean } = {}): Promise<BuildResult> {
    const started = Date.now();
    this.setPhase('building');

    // A cached "already up to date" from seconds ago is still true unless a
    // source changed, and the watcher would have told us if one had.
    if (!opts.force) {
      const cached = this.freshness.check();
      if (cached?.upToDate) {
        const result: BuildResult = {
          ok: true,
          exitCode: 0,
          durationMs: Date.now() - started,
          errors: [],
          warnings: [],
          upToDate: true,
          source: 'cache',
          rawTail: [],
        };
        this.lastBuild = result;
        this.setPhase(this.alive ? 'running' : 'stopped');
        this.emit('build', result);
        return result;
      }
    }

    // Without an engine there is no Build.bat to run. Fail here with the
    // resolution reason rather than joining an empty root into a nonsense
    // path, which would surface as a confusing "not found" later.
    if (!this.options.engineRoot) {
      const failure: BuildResult = {
        ok: false,
        exitCode: null,
        durationMs: Date.now() - started,
        errors: [
          {
            file: this.options.projectRoot,
            line: 0,
            column: 0,
            severity: 'error',
            code: 'ENGINE_UNRESOLVED',
            message:
              this.engine?.reason ??
              'No engine resolved: call prepare() first, or set engineRoot explicitly.',
          },
        ],
        warnings: [],
        upToDate: false,
        source: 'ubt',
        rawTail: [],
      };
      this.lastBuild = failure;
      this.setPhase(this.alive ? 'running' : 'stopped');
      this.emit('build', failure);
      return failure;
    }

    const buildBat = join(this.options.engineRoot, 'Engine', 'Build', 'BatchFiles', 'Build.bat');
    if (!existsSync(buildBat)) {
      const resolution = this.engine;
      const hint =
        resolution?.source === 'unresolved'
          ? resolution.reason ?? 'engine could not be resolved'
          : `Build.bat not found at ${buildBat}. Set engineRoot to the UE install.`;
      const result: BuildResult = {
        ok: false,
        exitCode: null,
        durationMs: Date.now() - started,
        errors: [
          {
            file: buildBat,
            line: 0,
            column: 0,
            severity: 'error',
            code: 'ENGINE_NOT_FOUND',
            message: hint,
          },
        ],
        warnings: [],
        upToDate: false,
        source: 'ubt',
        rawTail: [],
      };
      this.lastBuild = result;
      this.setPhase(this.alive ? 'running' : 'stopped');
      this.emit('build', result);
      return result;
    }

    const uproject = this.findUproject();
    if (!uproject) {
      const result: BuildResult = {
        ok: false,
        exitCode: null,
        durationMs: Date.now() - started,
        errors: [
          {
            file: this.options.projectRoot,
            line: 0,
            column: 0,
        severity: 'error',
        code: 'PROJECT_NOT_FOUND',
        message: `No .uproject found in ${this.options.projectRoot}.`,
      },
    ],
    warnings: [],
    // Nothing ran, so nothing is up to date.
    upToDate: false,
    source: 'ubt',
    rawTail: [],
  };
      this.lastBuild = result;
      this.setPhase(this.alive ? 'running' : 'stopped');
      this.emit('build', result);
      return result;
    }

    const args = [
      this.options.target,
      this.options.platform,
      this.options.configuration,
      // -Project is passed separately: when the command runs through
      // cmd.exe, embedding quotes in this array double-escapes them and UBT
      // reports "Unable to find project file".
      `-Project=${uproject}`,
      '-WaitMutex',
      '-FromMsBuild',
    ];

    const result = await this.runCollecting(buildBat, args, started, uproject);
    this.lastBuild = result;
    this.setPhase(this.alive ? 'running' : this.lastCrash ? 'crashed' : 'stopped');
    this.emit('build', result);
    return result;
  }

  /** Launch the editor as a child process and watch for its death. */
  async start(): Promise<EditorStateSnapshot> {
    if (this.alive) return this.snapshot();

    await this.prepare();
    this.setPhase('starting');

    if (!this.options.engineRoot) {
      throw new Error(
        `cannot start editor: no engine resolved (${this.engine?.reason ?? 'call prepare() first, or set engineRoot'})`,
      );
    }
    const editorExe = join(
      this.options.engineRoot,
      'Engine',
      'Binaries',
      this.options.platform,
      `UnrealEditor${this.options.platform === 'Win64' ? '.exe' : ''}`,
    );
    const uproject = this.findUproject();
    if (!existsSync(editorExe) || !uproject) {
      this.setPhase('stopped');
      throw new Error(
        `cannot start editor: editor=${editorExe} exists=${existsSync(editorExe)} project=${uproject}`,
      );
    }

    const args = [uproject, ...(this.options.extraArgs ?? [])];
    const child = spawn(editorExe, args, {
      cwd: this.options.projectRoot,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.startedAt = new Date().toISOString();
    this.logPath = join(this.options.projectRoot, 'Saved', 'Logs', `${this.options.projectName ?? 'Editor'}.log`);

    const out: string[] = [];
    // Same codepage concern as the build path: the editor writes localized
    // console text, and UTF-8 decoding would corrupt it.
    const decode = (chunk: Buffer): string => {
      if (process.platform !== 'win32') return chunk.toString('utf8');
      try {
        return new TextDecoder('gbk').decode(chunk);
      } catch {
        return chunk.toString('utf8');
      }
    };
    const pump = (chunk: Buffer) => {
      const text = decode(chunk);
      out.push(text);
      // The editor prints this once it is interactive; before that, python
      // calls would time out against a half-initialized process.
      if (text.includes('LogPython') || text.includes('Editor is ready') || text.includes('LogInit: Display: Engine is initialized')) {
        this.setPhase('running');
      }
    };
    child.stdout?.on('data', pump);
    child.stderr?.on('data', pump);

    child.on('exit', (code, signal) => {
      const crashed = code !== 0 && code !== null;
      const report = this.collectCrash(code, signal, out);
      if (crashed) {
        this.lastCrash = report;
        this.setPhase('crashed');
        this.emit('crash', report);
      } else {
        this.setPhase('stopped');
      }
      this.child = null;
    });

    child.on('error', (err) => {
      this.lastCrash = {
        detectedAt: new Date().toISOString(),
        exitCode: null,
        signal: null,
        summary: [`spawn error: ${err.message}`],
        logPath: this.logPath,
      };
      this.setPhase('crashed');
      this.emit('crash', this.lastCrash);
      this.child = null;
    });

    // Do not block on full startup; callers poll the phase.
    return this.snapshot();
  }

  /** Ask the editor to shut down, then stop our watchers. */
  async stop(force = false): Promise<void> {
    if (!this.child) {
      this.setPhase('stopped');
      return;
    }
    this.setPhase('stopping');
    const child = this.child;
    if (force) {
      child.kill('SIGKILL');
    } else {
      child.kill('SIGTERM');
      const exited = await Promise.race([
        new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
      ]);
      if (!exited) child.kill('SIGKILL');
    }
    this.child = null;
    this.setPhase('stopped');
  }

  /** Release watchers and timers. Does not kill the editor. */
  dispose(): void {
    this.watcher.close();
    this.freshness.close();
    this.removeAllListeners();
  }

  snapshot(): EditorStateSnapshot {
    const instance = this.instance ?? this.registry.get(this.options.projectRoot);
    return {
      projectRoot: this.options.projectRoot,
      projectName: instance?.projectName ?? this.options.projectName ?? 'unknown',
      phase: this.phaseValue,
      pid: this.child?.pid ?? null,
      endpoint: instance?.endpoint ?? {
        multicastGroup: '239.0.0.1',
        port: 0,
        bindAddress: '127.0.0.1',
      },
      provisioned: instance?.provisioned ?? 'unprovisioned',
      ...(this.engine ? { engine: this.engine } : {}),
      ...(this.lastBuild ? { lastBuild: this.lastBuild } : {}),
      ...(this.lastCrash ? { lastCrash: this.lastCrash } : {}),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
    };
  }

  private findUproject(): string | undefined {
    try {
      const hit = readdirSync(this.options.projectRoot).find((f) => f.endsWith('.uproject'));
      return hit ? join(this.options.projectRoot, hit) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Run a command, capturing output and classifying build diagnostics. */
  private async runCollecting(
    command: string,
    args: string[],
    started: number,
    uprojectHint?: string,
  ): Promise<BuildResult> {
    return new Promise((resolve) => {
      // On Windows a .bat is not an executable; it must go through cmd, or
      // spawn fails with EINVAL.
      const isBatch = /\.bat$/i.test(command);
      const launch = isBatch
        ? { command: 'cmd.exe', args: ['/c', command, ...args] }
        : { command, args };
      const child = spawn(launch.command, launch.args, {
        cwd: this.options.projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks: string[] = [];
      // MSVC/UBT emit the active console codepage (GBK on a zh-CN Windows),
      // not UTF-8. Decoding as UTF-8 turns every non-ASCII message into
      // replacement characters, so the model reads mojibake where it should
      // read the compiler's actual wording.
      const decode = (c: Buffer): string => {
        if (process.platform !== 'win32') return c.toString('utf8');
        try {
          return new TextDecoder('gbk').decode(c);
        } catch {
          return c.toString('utf8');
        }
      };
      child.stdout?.on('data', (c: Buffer) => chunks.push(decode(c)));
      child.stderr?.on('data', (c: Buffer) => chunks.push(decode(c)));

      // A spawn failure also fires 'close', so record it and let close finish.
      let spawnError: Error | null = null;
      child.on('error', (err) => {
        spawnError = err;
      });
      child.on('close', (code) => {
        if (spawnError) {
          resolve({
            ok: false,
            exitCode: null,
            durationMs: Date.now() - started,
            errors: [
              {
                file: command,
                line: 0,
                column: 0,
                severity: 'error',
                code: 'SPAWN_FAILED',
                message: spawnError.message,
              },
            ],
            warnings: [],
            upToDate: false,
            source: 'ubt',
            rawTail: chunks.join('').split(/\r?\n/).filter((l) => l.trim()).slice(-20),
          });
          return;
        }
        const text = chunks.join('');
        const lines = text.split(/\r?\n/);
        const errors: BuildError[] = [];
        const warnings: BuildError[] = [];
        for (const line of lines) {
          const parsed = parseDiagnostic(line);
          if (!parsed) continue;
          (parsed.severity === 'error' ? errors : warnings).push(parsed);
        }
        const ok = code === 0;
        // UBT prints this itself when it found no compile actions to run. It
        // is the authoritative "nothing needed doing" signal, and it is only
        // emitted on a successful run.
        const upToDate = ok && lines.some((l) => /^\s*Target is up to date\s*$/.test(l));
        // A non-zero exit with nothing parsed is still a failure the model
        // must be able to act on; surface UBT's own verdict rather than an
        // empty error list.
        if (!ok && errors.length === 0) {
          const reason =
            lines.find((l) => /Unhandled exception|Unable to find|error \w+|Exception:/i.test(l)) ??
            lines.reverse().find((l) => l.trim()) ??
            `build exited with code ${code}`;
          errors.push({
            file: uprojectHint ?? command,
            line: 0,
            column: 0,
            severity: 'error',
            code: `UBT_EXIT_${code}`,
            message: reason.trim(),
          });
        }
        // Only a successful run is a verdict. A failure means UBT never
        // reached one, so caching it could report "nothing to do" for a
        // project that does not compile.
        if (ok) this.freshness.record(upToDate);
        else this.freshness.invalidate();

        resolve({
          ok,
          exitCode: code,
          durationMs: Date.now() - started,
          errors,
          warnings,
          upToDate,
          source: 'ubt',
          // Keep the tail only on failure: it is what explains an unparsed
          // failure, and is noise on success.
          rawTail: ok ? [] : lines.filter((l) => l.trim()).slice(-40),
        });
      });
    });
  }

  /**
   * Build a crash report from process exit plus on-disk artifacts.
   *
   * The engine writes Saved/Crashes/<guid>; its newest entry is the most
   * useful pointer. The running log's tail often already contains the assert
   * or callstack, so that is included too.
   */
  private collectCrash(code: number | null, signal: string | null, streamed: string[]): CrashReport {
    const crashDir = this.newestCrashDir();
    const summary: string[] = [];
    const streamTail = streamed
      .join('')
      .split(/\r?\n/)
      .filter((l) => /error|assert|fatal|exception|crash|0x[0-9a-f]{8,}/i.test(l))
      .slice(-25);
    summary.push(...streamTail);

    const logPath = this.logPath ?? this.resolveLogPath();
    if (logPath && existsSync(logPath)) {
      try {
        const tail = readFileSync(logPath, 'utf8').split(/\r?\n/).slice(-400);
        summary.push(
          ...tail.filter((l) => /error|assert|fatal|exception|crash|callstack|0x[0-9a-f]{8,}/i.test(l)).slice(-25),
        );
      } catch {
        /* log may be locked by the dying process */
      }
    }

    return {
      detectedAt: new Date().toISOString(),
      exitCode: code,
      signal: signal ?? null,
      ...(crashDir ? { crashDir } : {}),
      summary: [...new Set(summary)].slice(-40),
      ...(logPath ? { logPath } : {}),
    };
  }

  private newestCrashDir(): string | undefined {
    const dir = join(this.options.projectRoot, 'Saved', 'Crashes');
    if (!existsSync(dir)) return undefined;
    try {
      const entries = readdirSync(dir)
        .map((name) => ({ name, full: join(dir, name) }))
        .filter((e) => statSync(e.full).isDirectory())
        .sort((a, b) => statSync(b.full).mtimeMs - statSync(a.full).mtimeMs);
      return entries[0]?.full;
    } catch {
      return undefined;
    }
  }

  private resolveLogPath(): string | undefined {
    const dir = join(this.options.projectRoot, 'Saved', 'Logs');
    if (!existsSync(dir)) return undefined;
    try {
      const logs = readdirSync(dir)
        .filter((f) => f.endsWith('.log'))
        .map((f) => ({ f, full: join(dir, f) }))
        .sort((a, b) => statSync(b.full).mtimeMs - statSync(a.full).mtimeMs);
      return logs[0]?.full;
    } catch {
      return undefined;
    }
  }
}

/**
 * Make the editor usable, deciding internally what that requires.
 *
 * The model asks for a usable editor; dsh decides whether the binaries are
 * stale (build first) or current (launch directly), and reports the outcome
 * including any build errors. Nothing here asks the model to choose.
 */
export async function ensureReady(
  session: EditorSession,
  options: { forceBuild?: boolean } = {},
): Promise<StartOutcome> {
  if (session.alive) {
    return { action: 'already_running', built: false, state: session.snapshot() };
  }

  // Ask UBT whether anything needs compiling. It is the only authority that
  // sees the whole picture: recorded action command lines, dependency-list
  // files, produced-file sizes, not just timestamps. Trying to launch first
  // and inferring a build from the failure text guesses, and guesses wrong
  // when binaries exist but are stale.
  //
  // prepare() first: it starts the source watcher, so an edit made during
  // this build invalidates the cached verdict instead of being missed.
  await session.prepare();
  const build = await session.build(...(options.forceBuild ? [{ force: true }] : []));
  if (!build.ok) {
    return {
      action: 'build_failed',
      built: true,
      ...{ build },
      state: session.snapshot(),
      ...{ note: `build failed with ${build.errors.length} error(s); editor not started` },
    };
  }

  if (build.upToDate && session.alive) {
    return { action: 'already_running', built: false, ...{ build }, state: session.snapshot() };
  }

  const built = !build.upToDate;
  try {
    const launched = await session.start();
    return {
      action: built ? 'built_and_launched' : 'launched',
      ...{ built },
      ...{ build },
      state: launched,
    };
  } catch (error) {
    return {
      action: 'launch_failed',
      ...{ built },
      ...{ build },
      state: session.snapshot(),
      ...{ note: error instanceof Error ? error.message : String(error) },
    };
  }
}

/**
 * Parse a UBT/compiler diagnostic line.
 *
 * Handles `path(line,col): error C2065: text`, MSBuild's `path(line,col): error
 * CS####:`, and clang's `path:line:col: error:`.
 */
export function parseDiagnostic(line: string): BuildError | undefined {
  const ms = /^(.*?)\((\d+)(?:,(\d+))?\)\s*:\s*(error|warning)\s+([A-Z]+\d*)\s*:\s*(.*)$/i.exec(
    line.trim(),
  );
  if (ms) {
    return {
      file: ms[1]!,
      line: Number(ms[2]),
      column: Number(ms[3] ?? 0),
      severity: ms[4]!.toLowerCase() === 'error' ? 'error' : 'warning',
      code: ms[5]!,
      message: ms[6]!.trim(),
    };
  }
  const clang = /^(.*?):(\d+):(\d+):\s*(error|warning):\s*(.*)$/i.exec(line.trim());
  if (clang) {
    return {
      file: clang[1]!,
      line: Number(clang[2]),
      column: Number(clang[3]),
      severity: clang[4]!.toLowerCase() === 'error' ? 'error' : 'warning',
      code: 'compiler',
      message: clang[5]!.trim(),
    };
  }
  return undefined;
}

/**
 * Last-resort engine root, exported only for callers that still import it.
 * It is NOT used as a default any more: a hardcoded path silently pins every
 * project to one engine, which is wrong the moment a project targets another.
 * The engine now comes from the project's own EngineAssociation.
 * Empty because no path is correct for all projects.
 */
export const DEFAULT_ENGINE_ROOT = '';
