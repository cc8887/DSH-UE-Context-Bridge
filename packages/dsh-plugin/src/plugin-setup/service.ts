/**
 * Decide and perform a GeneralBlueprint install.
 *
 * Nothing here runs because the plugin process started. `install()` runs only
 * after the setup page posts a click. A launcher engine receives one release
 * zip or a hard failure. A source engine receives the pinned git commit and a
 * build invoked from that engine's own Build.bat or Build.sh. A failed binary
 * check never falls through into a source build, and a source engine never
 * receives a prebuilt zip.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EngineSelectionStore, type EngineSelection } from '../engine-selection.ts';
import {
  enumerateEngineInstallations,
  isValidRootDirectory,
  resolveEngineRoot,
  type EngineInstallation,
} from '../toolchain.ts';
import {
  compareBuildIds,
  engineEditorManifest,
  formatEngineVersion,
  modulesPath,
  readBuildVersion,
  readModuleManifest,
  type BuildVersionFile,
} from './build-id.ts';
import { GENERAL_BLUEPRINT, MARKER_NAME, PLUGIN_NAME, USER_AGENT } from './constants.ts';
import {
  classifyEngineKind,
  engineIsDecided,
  enginePluginDir,
  projectPluginDir,
  type EngineKind,
} from './engine-kind.ts';
import {
  assertDownloadUrl,
  loadReleaseIndex,
  selectReleaseAsset,
  sha256File,
  type ReleaseAsset,
} from './release-index.ts';
import { extractPluginArchive } from './safe-extract.ts';
import { stageSourceTree } from './source-stage.ts';
import { enablePluginInUproject, findUproject } from './uproject-edit.ts';

const MAX_DOWNLOAD = 1024 * 1024 * 1024;

export interface InstallMarker {
  schema: 1;
  status: 'staged' | 'installed';
  mode: 'binary' | 'source';
  target: 'project' | 'engine';
  installedAt: string;
  engineRoot: string;
  engineVersion?: string;
  engineKind: string;
  releaseTag?: string;
  asset?: string;
  sha256?: string;
  sourceCommit?: string;
  sourceTag?: string;
  pluginVersion?: string;
  pluginBuildId?: string;
  engineBuildId?: string;
  upluginSha256: string;
  backupPath?: string;
}

interface Persisted {
  version: 1;
  dismissed: string[];
  kindChoice: Record<string, 'launcher' | 'source'>;
}

export interface StepState {
  id: string;
  label: string;
  state: 'pending' | 'active' | 'done' | 'error' | 'skipped';
  detail?: string;
}

export interface SetupView {
  projectRoot?: string;
  engine?: {
    decided: boolean;
    root?: string;
    resolution: string;
    version?: string;
    changelist?: number;
    compatibleChangelist?: number;
    branch?: string;
    detectedKind: EngineKind;
    effectiveKind?: 'launcher' | 'source';
    signals: string[];
    options: Array<{ identifier: string; root: string; version?: string }>;
    note?: string;
  };
  installed: {
    status: 'missing' | 'match' | 'mismatch' | 'user-owned' | 'staged';
    path?: string;
    versionName?: string;
    detail: string;
    pluginBuildId?: string;
    engineBuildId?: string;
  };
  plan: {
    mode: 'binary' | 'source' | 'none';
    reason: string;
    match?: 'exact-patch' | 'minor-line';
    assetName?: string;
    assetTag?: string;
    sha256?: string;
    sha256From?: string;
    sourceRepo: string;
    sourceCommit: string;
    sourceTag: string;
    targetDir?: string;
    engineTargetDir?: string;
    buildIdNote?: string;
    pluginBuildId?: string;
    engineBuildId?: string;
    buildIdStatus?: 'match' | 'mismatch' | 'unverified' | 'unchecked';
  };
  form: {
    canInstall: boolean;
    installLabel: string;
    needsReplace: boolean;
    needsUnverifiedConfirm: boolean;
    blockReason?: string;
  };
  prompt: { show: boolean; title: string; reason: string };
  fingerprint: string;
  job?: {
    phase: 'running' | 'failed' | 'cancelled' | 'done';
    steps: StepState[];
    logTail: string[];
    error?: string;
    backupPath?: string;
  };
}

export interface InstallRequest {
  target: 'project' | 'engine';
  replace?: boolean;
  confirmEngineWrite?: boolean;
  allowUnverifiedBuildId?: boolean;
}

export interface PluginSetupOptions {
  projectRoot?: string;
  engineRoot?: string;
  statePath: string;
  selectionPath?: string;
  backupRoot: string;
  logRoot: string;
  listEngines?: () => Promise<EngineInstallation[]>;
  fetchImpl?: typeof fetch;
  fetchSource?: (dest: string, signal: AbortSignal, log: (line: string) => void) => Promise<void>;
}

interface Job {
  phase: 'running' | 'failed' | 'cancelled' | 'done';
  steps: StepState[];
  log: string[];
  logFile: string;
  error?: string;
  backupPath?: string;
  abort: AbortController;
  child?: ChildProcess;
}

export class PluginSetup {
  private projectRoot: string | undefined;
  private readonly store: EngineSelectionStore;
  private job: Job | undefined;
  private releaseCache: { at: number; assets: ReleaseAsset[] } | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PluginSetupOptions) {
    this.projectRoot = options.projectRoot;
    this.store = new EngineSelectionStore(options.selectionPath);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async setProject(projectRoot: string): Promise<SetupView> {
    this.projectRoot = projectRoot;
    return this.view();
  }

  async selectEngine(choice: string): Promise<SetupView> {
    const project = this.requireProject();
    const installed = await this.engines();
    const picked = pickEngine(choice, installed);
    if (!picked || !isValidRootDirectory(picked.root)) {
      throw new SetupError(`No installed engine matches "${choice}".`);
    }
    const version = readBuildVersion(picked.root);
    const selection: EngineSelection = {
      identifier: picked.identifier,
      engineRoot: picked.root,
      decidedAt: new Date().toISOString(),
      ...(version ? { version: formatEngineVersion(version) } : {}),
    };
    this.store.set(project, selection);
    return this.view();
  }

  /** Explicit launcher/source choice. Overrides a confident detection until cleared by choosing again. */
  async chooseKind(kind: 'launcher' | 'source'): Promise<SetupView> {
    const view = await this.assess();
    const root = view.engine?.root;
    if (!root || !view.engine?.decided) throw new SetupError('Choose an engine before choosing launcher or source.');
    const persisted = this.readPersisted();
    persisted.kindChoice[keyFor(root)] = kind;
    this.writePersisted(persisted);
    return this.view();
  }

  async dismiss(): Promise<SetupView> {
    const view = await this.assess();
    const persisted = this.readPersisted();
    persisted.dismissed = [...persisted.dismissed.filter((item) => item !== view.fingerprint), view.fingerprint].slice(-50);
    this.writePersisted(persisted);
    return this.view();
  }

  cancel(): void {
    if (!this.job || this.job.phase !== 'running') return;
    this.job.abort.abort();
    this.job.child?.kill('SIGTERM');
    this.job.phase = 'cancelled';
    this.job.error = 'Cancelled.';
    this.log('cancelled');
  }

  async view(): Promise<SetupView> {
    const assessed = await this.assess();
    if (!this.job) return assessed;
    return {
      ...assessed,
      job: {
        phase: this.job.phase,
        steps: this.job.steps.map((step) => ({ ...step })),
        logTail: this.job.log.slice(-80),
        ...(this.job.error ? { error: this.job.error } : {}),
        ...(this.job.backupPath ? { backupPath: this.job.backupPath } : {}),
      },
    };
  }

  async install(request: InstallRequest): Promise<SetupView> {
    if (this.job?.phase === 'running') throw new SetupError('An install is already running.', 409);
    const assessed = await this.assess();
    this.assertInstallable(assessed, request);
    mkdirSync(this.options.logRoot, { recursive: true });
    this.job = {
      phase: 'running',
      steps: initialSteps(),
      log: [],
      logFile: join(this.options.logRoot, `${randomBytes(4).toString('hex')}.log`),
      abort: new AbortController(),
    };
    void this.runInstall(assessed, request, this.job.abort.signal).catch((error: unknown) => {
      if (!this.job || this.job.phase === 'cancelled') return;
      this.fail(error instanceof Error ? error.message : String(error));
    });
    return this.view();
  }

  private async runInstall(assessed: SetupView, request: InstallRequest, signal: AbortSignal): Promise<void> {
    const engineRoot = assessed.engine?.root;
    const project = assessed.projectRoot;
    const kind = assessed.engine?.effectiveKind;
    if (!engineRoot || !project || (kind !== 'launcher' && kind !== 'source')) {
      throw new SetupError('Engine is not decided.');
    }
    const version = readBuildVersion(engineRoot);
    if (!version) throw new SetupError('Engine/Build/Build.version is missing or unreadable.');
    const targetDir = request.target === 'engine' ? enginePluginDir(engineRoot) : projectPluginDir(project);

    this.step('permission', 'active');
    assertWritable(request.target === 'engine' ? join(engineRoot, 'Engine', 'Plugins') : join(project, 'Plugins'));
    this.step('permission', 'done', targetDir);
    throwIfAborted(signal);

    let stagedFrom: string | undefined;
    let cleanup: string | undefined;
    let mode: InstallMarker['mode'];
    let extra: Partial<InstallMarker> = {};
    try {
    if (kind === 'launcher') {
      mode = 'binary';
      this.step('fetch', 'skipped', 'launcher engines use a release package');
      this.step('stage', 'skipped');
      this.step('build', 'skipped', 'the release package is already compiled');
      const binary = await this.installBinary(engineRoot, version, signal);
      stagedFrom = binary.root;
      cleanup = binary.container;
      const verdict = compareBuildIds(binary.manifest, engineEditorManifest(engineRoot, 'Win64'));
      extra = {
        releaseTag: binary.asset.tag,
        asset: binary.asset.name,
        ...(binary.asset.sha256 ? { sha256: binary.asset.sha256 } : {}),
        ...(binary.manifest?.buildId ? { pluginBuildId: binary.manifest.buildId } : {}),
        ...(engineEditorManifest(engineRoot, 'Win64')?.buildId
          ? { engineBuildId: engineEditorManifest(engineRoot, 'Win64')?.buildId }
          : {}),
      };
      if (verdict.status === 'mismatch') throw new SetupError(verdict.note);
      if (verdict.status === 'unverified' && request.allowUnverifiedBuildId !== true) throw new SetupError(verdict.note);
      this.step('build-id', 'done', verdict.note);
    } else {
      mode = 'source';
      this.step('select', 'skipped', 'source engines do not take a prebuilt package');
      this.step('download', 'skipped');
      this.step('extract', 'skipped');
      this.step('build-id', 'skipped', 'the engine compiles this tree itself');
      const continueBuild = assessed.installed.status === 'staged' && request.replace !== true;
      if (continueBuild && existsSync(join(targetDir, `${PLUGIN_NAME}.uplugin`))) {
        this.step('fetch', 'skipped', 'staged tree kept');
        this.step('stage', 'skipped', targetDir);
        stagedFrom = targetDir;
      } else {
        stagedFrom = await this.installSource(version, signal);
        cleanup = stagedFrom;
      }
      extra = { sourceCommit: GENERAL_BLUEPRINT.sourceCommit, sourceTag: GENERAL_BLUEPRINT.sourceTag };
    }
    throwIfAborted(signal);

    if (stagedFrom && stagedFrom !== targetDir) {
      assertNoLinks(stagedFrom);
      this.step('place', 'active', targetDir);
      let backupPath: string | undefined;
      if (existsSync(targetDir)) {
        backupPath = this.backup(targetDir);
        this.job!.backupPath = backupPath;
        rmSync(targetDir, { recursive: true, force: true });
      }
      try {
        mkdirSync(dirname(targetDir), { recursive: true });
        cpSync(stagedFrom, targetDir, { recursive: true, dereference: false });
      } catch (error) {
        if (!existsSync(targetDir) && backupPath) cpSync(backupPath, targetDir, { recursive: true, dereference: false });
        throw error;
      }
      this.step('place', 'done', backupPath ? `previous copy saved at ${backupPath}` : targetDir);
    } else {
      this.step('place', 'skipped', targetDir);
    }
    const uplugin = join(targetDir, `${PLUGIN_NAME}.uplugin`);
    const versionName = readVersionName(uplugin);
    const marker: InstallMarker = {
      schema: 1,
      status: 'staged',
      mode,
      target: request.target,
      installedAt: new Date().toISOString(),
      engineRoot,
      engineVersion: formatEngineVersion(version),
      engineKind: kind,
      ...(versionName ? { pluginVersion: versionName } : {}),
      upluginSha256: sha256File(readFileSync(uplugin)),
      ...(this.job?.backupPath ? { backupPath: this.job.backupPath } : {}),
      ...extra,
    };
    writeMarker(targetDir, marker);

    this.step('uproject', 'active');
    const uproject = findUproject(project);
    if (!uproject) throw new SetupError(`No .uproject in ${project}.`);
    const descriptorBackup = `${uproject}.ue-bridge-backup`;
    const enabled = enablePluginInUproject(uproject, descriptorBackup);
    this.step(
      'uproject',
      'done',
      enabled.changed ? `enabled ${PLUGIN_NAME}; previous descriptor at ${descriptorBackup}` : `${PLUGIN_NAME} was already enabled`,
    );
    throwIfAborted(signal);

    if (mode === 'source') {
      await this.runBuild(engineRoot, project, signal);
      const built = readModuleManifest(modulesPath(targetDir, 'Win64')) ?? readModuleManifest(modulesPath(targetDir, 'Linux'));
      writeMarker(targetDir, { ...marker, status: 'installed', ...(built?.buildId ? { pluginBuildId: built.buildId } : {}) });
    } else {
      writeMarker(targetDir, { ...marker, status: 'installed' });
    }
    this.step('done', 'done', targetDir);
    if (this.job) this.job.phase = 'done';
    this.log(`installed ${mode} at ${targetDir}`);
    } finally {
      if (cleanup && cleanup !== targetDir) rmSync(cleanup, { recursive: true, force: true });
    }
  }

  private async installBinary(engineRoot: string, version: BuildVersionFile, signal: AbortSignal) {
    this.step('select', 'active');
    if (!existsSync(join(engineRoot, 'Engine', 'Binaries', 'Win64'))) {
      throw new SetupError('This engine has no Engine/Binaries/Win64. Published packages are Win64 only.');
    }
    const selected = selectReleaseAsset(version, await this.releases());
    if (!selected.ok) throw new SetupError(selected.reason);
    if (!selected.asset.sha256) throw new SetupError(`${selected.asset.name} has no SHA-256 digest or SHA256SUMS entry.`);
    this.step('select', 'done', `${selected.match} ${selected.asset.tag}/${selected.asset.name}`);
    throwIfAborted(signal);

    this.step('download', 'active', selected.asset.downloadUrl);
    const zipPath = join(tmpdir(), `generalblueprint-${randomBytes(4).toString('hex')}.zip`);
    try {
      await downloadChecked(this.fetchImpl, selected.asset, zipPath, signal, (bytes) => {
        this.step('download', 'active', `${bytes} bytes`);
      });
      this.step('download', 'done', selected.asset.sha256);
      throwIfAborted(signal);
      this.step('extract', 'active');
      const container = join(tmpdir(), `generalblueprint-${randomBytes(4).toString('hex')}`);
      const root = await extractPluginArchive(zipPath, container);
      this.step('extract', 'done', root);
      this.step('build-id', 'active');
      return { root, container, asset: selected.asset, manifest: readModuleManifest(modulesPath(root, 'Win64')) };
    } finally {
      rmSync(zipPath, { force: true });
    }
  }

  private async installSource(version: BuildVersionFile, signal: AbortSignal): Promise<string> {
    this.step('fetch', 'active', `${GENERAL_BLUEPRINT.gitUrl} @ ${GENERAL_BLUEPRINT.sourceCommit}`);
    const checkout = join(tmpdir(), `generalblueprint-src-${randomBytes(4).toString('hex')}`);
    const fetchSource = this.options.fetchSource ?? defaultFetchSource;
    await fetchSource(checkout, signal, (line) => this.log(line));
    this.step('fetch', 'done', GENERAL_BLUEPRINT.sourceCommit);
    throwIfAborted(signal);
    this.step('stage', 'active');
    const staged = join(tmpdir(), `generalblueprint-stage-${randomBytes(4).toString('hex')}`);
    stageSourceTree(checkout, staged, version);
    rmSync(checkout, { recursive: true, force: true });
    this.step('stage', 'done', version.major === 5 && version.minor === 8 ? 'UE 5.8 MCP modules merged' : 'base plugin; MCP modules left out');
    return staged;
  }

  private async runBuild(engineRoot: string, projectRoot: string, signal: AbortSignal): Promise<void> {
    const tool = resolveBuildTool(engineRoot);
    if (!tool) throw new SetupError(`No Build.bat or Linux/Build.sh under ${engineRoot}.`);
    const uproject = findUproject(projectRoot);
    if (!uproject) throw new SetupError(`No .uproject in ${projectRoot}.`);
    const args = ['UnrealEditor', tool.platform, 'Development', `-Project=${uproject}`, '-WaitMutex'];
    this.step('build', 'active', `${tool.file} ${args.join(' ')}`);
    const code = await this.spawnBuild(tool, args, engineRoot, signal);
    if (code !== 0) throw new SetupError(`Build exited ${code}.`);
    this.step('build', 'done', `exit 0 (${tool.platform})`);
  }

  private spawnBuild(
    tool: { file: string; kind: 'bat' | 'sh'; platform: 'Win64' | 'Linux' },
    args: string[],
    cwd: string,
    signal: AbortSignal,
  ): Promise<number> {
    const command = tool.kind === 'bat' ? 'cmd.exe' : tool.file;
    const commandArgs = tool.kind === 'bat' ? ['/d', '/c', tool.file, ...args] : args;
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, commandArgs, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (this.job) this.job.child = child;
      const onAbort = () => child.kill('SIGTERM');
      signal.addEventListener('abort', onAbort, { once: true });
      child.stdout?.on('data', (chunk: Buffer) => this.log(chunk.toString('utf8').trimEnd()));
      child.stderr?.on('data', (chunk: Buffer) => this.log(chunk.toString('utf8').trimEnd()));
      child.on('error', (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      });
      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) reject(new SetupError('Cancelled.'));
        else resolvePromise(code ?? 1);
      });
    });
  }

  private assertInstallable(view: SetupView, request: InstallRequest): void {
    if (!view.projectRoot) throw new SetupError('Set a project before installing.');
    if (!view.engine?.decided || !view.engine.root) throw new SetupError(view.engine?.note ?? 'Engine is not decided.');
    if (!view.engine.effectiveKind) throw new SetupError('Choose whether this engine is a launcher install or a source build.');
    if (request.target !== 'project' && request.target !== 'engine') throw new SetupError('Target must be project or engine.');
    if (request.target === 'engine' && request.confirmEngineWrite !== true) {
      throw new SetupError('Writing into the engine tree requires confirmEngineWrite.');
    }
    const replacingStaged = view.installed.status === 'staged' && request.replace !== true && view.engine.effectiveKind === 'source';
    if (view.installed.status !== 'missing' && !replacingStaged && request.replace !== true) {
      throw new SetupError('The plugin directory already exists. Confirm replace to overwrite it.');
    }
    if (view.engine.effectiveKind === 'launcher' && view.plan.mode !== 'binary') throw new SetupError(view.plan.reason);
    if (view.engine.effectiveKind === 'source' && view.plan.mode !== 'source') throw new SetupError(view.plan.reason);
    if (
      view.engine.effectiveKind === 'launcher' &&
      view.plan.buildIdStatus === 'unverified' &&
      request.allowUnverifiedBuildId !== true
    ) {
      throw new SetupError(view.plan.buildIdNote ?? 'BuildId cannot be verified.');
    }
  }

  private async assess(): Promise<SetupView> {
    const persisted = this.readPersisted();
    const projectRoot = this.projectRoot;
    let engineInfo: SetupView['engine'];
    let version: BuildVersionFile | undefined;
    if (projectRoot) {
      const recorded = this.store.get(projectRoot);
      const uprojectPath = findUproject(projectRoot);
      let descriptor: { EngineAssociation?: string } | undefined;
      if (uprojectPath) {
        try {
          descriptor = JSON.parse(readFileSync(uprojectPath, 'utf8').replace(/^\uFEFF/, '')) as {
            EngineAssociation?: string;
          };
        } catch {
          descriptor = undefined;
        }
      }
      const resolution = await resolveEngineRoot(
        projectRoot,
        descriptor,
        recorded?.engineRoot ?? this.options.engineRoot,
        uprojectPath,
      );
      const installations = await this.engines();
      const decided = engineIsDecided(resolution, Boolean(recorded?.engineRoot));
      version = resolution.engineRoot ? readBuildVersion(resolution.engineRoot) : undefined;
      const classified = resolution.engineRoot
        ? classifyEngineKind(resolution.engineRoot, installations)
        : { kind: 'ambiguous' as const, signals: ['engine unresolved'] };
      const chosen = resolution.engineRoot ? persisted.kindChoice[keyFor(resolution.engineRoot)] : undefined;
      const detectedUsable = classified.kind === 'launcher' || classified.kind === 'source' ? classified.kind : undefined;
      const effective = chosen ?? detectedUsable;
      engineInfo = {
        decided,
        ...(resolution.engineRoot ? { root: resolution.engineRoot } : {}),
        resolution: resolution.source,
        ...(formatEngineVersion(version) ? { version: formatEngineVersion(version) } : {}),
        ...(version?.changelist !== undefined ? { changelist: version.changelist } : {}),
        ...(version?.compatibleChangelist !== undefined ? { compatibleChangelist: version.compatibleChangelist } : {}),
        ...(version?.branch ? { branch: version.branch } : {}),
        detectedKind: classified.kind,
        ...(effective ? { effectiveKind: effective } : {}),
        signals: classified.signals,
        options: installations.map((item) => ({
          identifier: item.identifier,
          root: item.root,
          ...(item.version ? { version: item.version } : {}),
        })),
        ...(!decided
          ? {
              note:
                resolution.reason ??
                (resolution.source === 'parent-directory'
                  ? 'An engine was found above the project. Choose one explicitly.'
                  : 'Choose the engine for this project.'),
            }
          : {}),
      };
    }

    const targetDir = projectRoot ? projectPluginDir(projectRoot) : undefined;
    const installed = describeInstalled(targetDir, version, engineInfo?.root);
    const plan = await this.plan(engineInfo, version, installed);
    const needsReplace = installed.status === 'user-owned' || installed.status === 'mismatch' || installed.status === 'match';
    let blockReason: string | undefined;
    if (!projectRoot) blockReason = '还没有项目路径。';
    else if (!engineInfo?.decided) blockReason = engineInfo?.note ?? '引擎还没确定。';
    else if (!engineInfo.effectiveKind) blockReason = '公版还是源码版还没确定。';
    else if (plan.mode === 'none') blockReason = plan.reason;
    const attention = !projectRoot || installed.status !== 'match' || Boolean(blockReason);
    const fingerprint = [
      projectRoot ?? '',
      engineInfo?.root ?? '',
      engineInfo?.detectedKind ?? '',
      engineInfo?.effectiveKind ?? '',
      installed.status,
      plan.mode,
      plan.reason,
      plan.assetName ?? '',
    ].join('|');
    const dismissed = persisted.dismissed.includes(fingerprint);
    const prompt =
      !dismissed && this.job?.phase !== 'running' && (attention || !projectRoot)
        ? {
            show: true,
            title: projectRoot ? promptTitle(installed.status, engineInfo?.effectiveKind) : '设置 GeneralBlueprint',
            reason: projectRoot ? plan.reason : '填写项目路径并确认引擎后才能安装。',
          }
        : { show: false, title: '', reason: '' };

    return {
      ...(projectRoot ? { projectRoot } : {}),
      ...(engineInfo ? { engine: engineInfo } : {}),
      installed,
      plan,
      form: {
        canInstall: !blockReason,
        installLabel:
          installed.status === 'staged' && engineInfo?.effectiveKind === 'source'
            ? '继续编译'
            : engineInfo?.effectiveKind === 'source'
              ? '拉取源码并编译'
              : '安装发布包',
        needsReplace,
        needsUnverifiedConfirm: plan.buildIdStatus === 'unverified' && engineInfo?.effectiveKind === 'launcher',
        ...(blockReason ? { blockReason } : {}),
      },
      prompt,
      fingerprint,
    };
  }

  private async plan(
    engine: SetupView['engine'],
    version: BuildVersionFile | undefined,
    installed: SetupView['installed'],
  ): Promise<SetupView['plan']> {
    const base = {
      sourceRepo: GENERAL_BLUEPRINT.gitUrl,
      sourceCommit: GENERAL_BLUEPRINT.sourceCommit,
      sourceTag: GENERAL_BLUEPRINT.sourceTag,
      ...(engine?.root && this.projectRoot ? { targetDir: projectPluginDir(this.projectRoot) } : {}),
      ...(engine?.root ? { engineTargetDir: enginePluginDir(engine.root) } : {}),
    };
    if (!engine?.decided || !engine.root || !version) {
      return { ...base, mode: 'none', reason: engine?.note ?? '引擎尚未确定。不会猜测，也不会安装。', buildIdStatus: 'unchecked' };
    }
    if (!engine.effectiveKind) {
      return { ...base, mode: 'none', reason: '检测信号不足以区分公版和源码版。请明确选择。', buildIdStatus: 'unchecked' };
    }
    if (installed.status === 'match') {
      return {
        ...base,
        mode: engine.effectiveKind === 'launcher' ? 'binary' : 'source',
        reason: '已安装，且与当前引擎记录一致。再次安装需要勾选覆盖。',
        buildIdStatus: 'unchecked',
      };
    }
    if (engine.effectiveKind === 'source') {
      const mcp = version.major === 5 && version.minor === 8 ? 'UE 5.8 会合并 MCP 模块后再编译。' : '非 5.8 不合并 MCP 模块。';
      return {
        ...base,
        mode: 'source',
        reason: `源码版：克隆 ${GENERAL_BLUEPRINT.sourceTag}（${GENERAL_BLUEPRINT.sourceCommit}），再用这个引擎自己的构建脚本编译。${mcp}不会改用发布包。`,
        buildIdStatus: 'unchecked',
      };
    }
    if (!existsSync(join(engine.root, 'Engine', 'Binaries', 'Win64'))) {
      return { ...base, mode: 'none', reason: '公版安装只接受 Win64 发布包，这个引擎没有 Engine/Binaries/Win64。不会改用源码编译。', buildIdStatus: 'unchecked' };
    }
    try {
      const selected = selectReleaseAsset(version, await this.releases());
      if (!selected.ok) {
        return { ...base, mode: 'none', reason: `${selected.reason} 不会改用源码编译。`, buildIdStatus: 'unchecked' };
      }
      const engineManifest = engineEditorManifest(engine.root, 'Win64');
      return {
        ...base,
        mode: 'binary',
        match: selected.match,
        reason:
          selected.match === 'exact-patch'
            ? `公版：使用 ${selected.asset.tag} 的 ${selected.asset.name}。解压后对照 UnrealEditor.modules 的 BuildId，不一致就停止，不会改编译源码。`
            : `公版：没有这个补丁号的单独包，使用 ${selected.asset.name}（发布按 ${selected.asset.versionLabel} 整条线提供）。BuildId 仍以两边的 UnrealEditor.modules 为准。`,
        assetName: selected.asset.name,
        assetTag: selected.asset.tag,
        ...(selected.asset.sha256 ? { sha256: selected.asset.sha256 } : {}),
        ...(selected.asset.sha256From ? { sha256From: selected.asset.sha256From } : {}),
        ...(engineManifest?.buildId ? { engineBuildId: engineManifest.buildId } : {}),
        buildIdStatus: engineManifest?.buildId ? 'unchecked' : 'unverified',
        buildIdNote: engineManifest?.buildId
          ? `编辑器 UnrealEditor.modules BuildId 是 ${engineManifest.buildId}。Build.version 的 Changelist / CompatibleChangelist 不代替这份清单。`
          : '引擎缺少 Engine/Binaries/Win64/UnrealEditor.modules。不能把 Changelist 当成 BuildId，所以默认不安装。',
      };
    } catch (error) {
      return { ...base, mode: 'none', reason: error instanceof Error ? error.message : String(error), buildIdStatus: 'unchecked' };
    }
  }

  private async releases(): Promise<ReleaseAsset[]> {
    if (this.releaseCache && Date.now() - this.releaseCache.at < 5 * 60_000) return this.releaseCache.assets;
    const assets = await loadReleaseIndex(this.fetchImpl);
    this.releaseCache = { at: Date.now(), assets };
    return assets;
  }

  private async engines(): Promise<EngineInstallation[]> {
    return this.options.listEngines ? this.options.listEngines() : enumerateEngineInstallations();
  }

  private requireProject(): string {
    if (!this.projectRoot) throw new SetupError('Set a project path first.');
    return this.projectRoot;
  }

  private backup(targetDir: string): string {
    const dest = join(this.options.backupRoot, `${Date.now()}`);
    mkdirSync(dest, { recursive: true });
    cpSync(targetDir, dest, { recursive: true, dereference: false });
    return dest;
  }

  private step(id: string, state: StepState['state'], detail?: string): void {
    const step = this.job?.steps.find((item) => item.id === id);
    if (!step) return;
    step.state = state;
    if (detail) step.detail = detail;
  }

  private log(line: string): void {
    if (!this.job || !line) return;
    for (const part of line.split(/\r?\n/)) if (part) this.job.log.push(part);
    if (this.job.log.length > 400) this.job.log.splice(0, this.job.log.length - 400);
    try {
      appendFileSync(this.job.logFile, `${line}\n`);
    } catch {
      /* the panel still has the tail */
    }
  }

  private fail(message: string): void {
    if (!this.job) return;
    this.job.phase = message === 'Cancelled.' ? 'cancelled' : 'failed';
    this.job.error = message;
    const active = this.job.steps.find((step) => step.state === 'active');
    if (active) active.state = 'error';
    this.log(message);
  }

  private readPersisted(): Persisted {
    if (!existsSync(this.options.statePath)) return { version: 1, dismissed: [], kindChoice: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.options.statePath, 'utf8')) as Persisted;
      if (parsed?.version !== 1) return { version: 1, dismissed: [], kindChoice: {} };
      return {
        version: 1,
        dismissed: Array.isArray(parsed.dismissed) ? parsed.dismissed.filter((item) => typeof item === 'string') : [],
        kindChoice: parsed.kindChoice && typeof parsed.kindChoice === 'object' ? parsed.kindChoice : {},
      };
    } catch {
      return { version: 1, dismissed: [], kindChoice: {} };
    }
  }

  private writePersisted(value: Persisted): void {
    mkdirSync(dirname(this.options.statePath), { recursive: true });
    writeFileSync(this.options.statePath, JSON.stringify(value, null, 2), 'utf8');
  }
}

export class SetupError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'SetupError';
  }
}

function initialSteps(): StepState[] {
  const rows: Array<[string, string]> = [
    ['permission', '检查目标目录是否可写'],
    ['select', '选择与引擎版本对应的发布包'],
    ['download', '下载并校验 SHA-256'],
    ['extract', '安全解压'],
    ['fetch', '获取固定 commit 的源码'],
    ['stage', '准备插件目录'],
    ['build-id', '对照 UnrealEditor.modules BuildId'],
    ['place', '写入目标目录'],
    ['uproject', '在 .uproject 中启用 GeneralBlueprint'],
    ['build', '用当前引擎编译'],
    ['done', '完成'],
  ];
  return rows.map(([id, label]) => ({ id, label, state: 'pending' }));
}

function promptTitle(status: SetupView['installed']['status'], kind: 'launcher' | 'source' | undefined): string {
  if (status === 'mismatch') return 'GeneralBlueprint 与当前引擎不一致';
  if (status === 'user-owned') return '项目里已有一份 GeneralBlueprint';
  if (status === 'staged') return '源码已就位，编译还没完成';
  if (!kind) return '需要确认这台引擎是公版还是源码版';
  return '尚未安装 GeneralBlueprint';
}

function describeInstalled(
  targetDir: string | undefined,
  version: BuildVersionFile | undefined,
  engineRoot: string | undefined,
): SetupView['installed'] {
  if (!targetDir) return { status: 'missing', detail: '还没有项目，无法检查 Plugins 目录。' };
  const uplugin = join(targetDir, `${PLUGIN_NAME}.uplugin`);
  if (!existsSync(uplugin)) return { status: 'missing', path: targetDir, detail: '目标目录没有 GeneralBlueprint.uplugin。' };
  const versionName = readVersionName(uplugin);
  const marker = readMarker(targetDir);
  const hash = sha256File(readFileSync(uplugin));
  if (!marker || marker.upluginSha256 !== hash) {
    return {
      status: 'user-owned',
      path: targetDir,
      ...(versionName ? { versionName } : {}),
      detail: marker
        ? '插件描述文件在安装之后被改过。不会覆盖，除非你勾选覆盖。'
        : '目录里已有插件，但没有本安装器留下的记录。不会覆盖，除非你勾选覆盖。',
    };
  }
  if (marker.status === 'staged') {
    return {
      status: 'staged',
      path: targetDir,
      ...(versionName ? { versionName } : {}),
      detail: `源码已放到目标目录（${marker.sourceCommit ?? 'unknown commit'}），编译尚未完成。`,
    };
  }
  if (engineRoot && normalize(marker.engineRoot) !== normalize(engineRoot)) {
    return {
      status: 'mismatch',
      path: targetDir,
      ...(versionName ? { versionName } : {}),
      detail: `记录里的引擎是 ${marker.engineRoot}，当前是 ${engineRoot}。`,
    };
  }
  const current = formatEngineVersion(version);
  if (current && marker.engineVersion && current !== marker.engineVersion) {
    return {
      status: 'mismatch',
      path: targetDir,
      ...(versionName ? { versionName } : {}),
      detail: `记录的引擎版本是 ${marker.engineVersion}，当前是 ${current}。`,
    };
  }
  if (marker.mode === 'source' && marker.sourceCommit && marker.sourceCommit !== GENERAL_BLUEPRINT.sourceCommit) {
    return {
      status: 'mismatch',
      path: targetDir,
      ...(versionName ? { versionName } : {}),
      detail: `已安装源码 ${marker.sourceCommit}，当前固定提交是 ${GENERAL_BLUEPRINT.sourceCommit}。`,
    };
  }
  return {
    status: 'match',
    path: targetDir,
    ...(versionName ? { versionName } : {}),
    ...(marker.pluginBuildId ? { pluginBuildId: marker.pluginBuildId } : {}),
    ...(marker.engineBuildId ? { engineBuildId: marker.engineBuildId } : {}),
    detail: `已安装（${marker.mode}，${marker.pluginVersion ?? versionName ?? '未知版本'}）。`,
  };
}

function readVersionName(uplugin: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(uplugin, 'utf8')) as { VersionName?: string };
    return typeof parsed.VersionName === 'string' ? parsed.VersionName : undefined;
  } catch {
    return undefined;
  }
}

function readMarker(dir: string): InstallMarker | undefined {
  const path = join(dir, MARKER_NAME);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as InstallMarker;
    return parsed?.schema === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeMarker(dir: string, marker: InstallMarker): void {
  writeFileSync(join(dir, MARKER_NAME), JSON.stringify(marker, null, 2), 'utf8');
}

function assertWritable(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.ue-bridge-write-probe-${process.pid}`);
    writeFileSync(probe, 'ok');
    rmSync(probe);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    throw new SetupError(`Cannot write ${dir}${code ? ` (${code})` : ''}.`);
  }
}

function assertNoLinks(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new SetupError(`Refusing to install a symlink: ${full}`);
    if (entry.isDirectory()) assertNoLinks(full);
  }
}

function resolveBuildTool(engineRoot: string): { file: string; kind: 'bat' | 'sh'; platform: 'Win64' | 'Linux' } | undefined {
  const bat = join(engineRoot, 'Engine', 'Build', 'BatchFiles', 'Build.bat');
  const sh = join(engineRoot, 'Engine', 'Build', 'BatchFiles', 'Linux', 'Build.sh');
  if (process.platform === 'win32' && existsSync(bat)) return { file: bat, kind: 'bat', platform: 'Win64' };
  if (existsSync(sh)) return { file: sh, kind: 'sh', platform: 'Linux' };
  if (existsSync(bat)) return { file: bat, kind: 'bat', platform: 'Win64' };
  return undefined;
}

async function defaultFetchSource(dest: string, signal: AbortSignal, log: (line: string) => void): Promise<void> {
  mkdirSync(dest, { recursive: true });
  const run = (args: string[]) => git(args, dest, signal, log);
  await run(['init']);
  await run(['remote', 'add', 'origin', GENERAL_BLUEPRINT.gitUrl]);
  await run(['fetch', '--depth', '1', 'origin', GENERAL_BLUEPRINT.sourceCommit]);
  await run(['checkout', '--detach', 'FETCH_HEAD']);
  const head = (await gitCapture(['rev-parse', 'HEAD'], dest, signal)).trim();
  if (head !== GENERAL_BLUEPRINT.sourceCommit) {
    throw new SetupError(`Fetched HEAD ${head} is not the pinned commit ${GENERAL_BLUEPRINT.sourceCommit}.`);
  }
}

function git(args: string[], cwd: string, signal: AbortSignal, log: (line: string) => void): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const onAbort = () => child.kill('SIGTERM');
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => log(chunk.toString('utf8').trimEnd()));
    child.stderr?.on('data', (chunk: Buffer) => log(chunk.toString('utf8').trimEnd()));
    child.on('error', reject);
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) reject(new SetupError('Cancelled.'));
      else if (code === 0) resolvePromise();
      else reject(new SetupError(`git ${args.join(' ')} exited ${code}`));
    });
  });
}

function gitCapture(args: string[], cwd: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (signal.aborted) reject(new SetupError('Cancelled.'));
      else if (code === 0) resolvePromise(Buffer.concat(chunks).toString('utf8'));
      else reject(new SetupError(`git ${args.join(' ')} exited ${code}`));
    });
  });
}

async function downloadChecked(
  fetchImpl: typeof fetch,
  asset: ReleaseAsset,
  dest: string,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
): Promise<void> {
  if (!asset.sha256) throw new SetupError(`${asset.name} has no SHA-256.`);
  let current = asset.downloadUrl;
  const prefix = `https://github.com/${GENERAL_BLUEPRINT.owner}/${GENERAL_BLUEPRINT.repo}/releases/download/`;
  if (!current.startsWith(prefix)) throw new SetupError('Refusing a download that is not this repository\'s release.');
  let response: Response | undefined;
  for (let hop = 0; hop < 5; hop += 1) {
    assertDownloadUrl(current);
    const next = await fetchImpl(current, { redirect: 'manual', signal, headers: { 'user-agent': USER_AGENT } });
    if (next.status >= 300 && next.status < 400) {
      const location = next.headers.get('location');
      if (!location) throw new SetupError('Download redirect is missing a location.');
      current = new URL(location, current).toString();
      continue;
    }
    response = next;
    break;
  }
  if (!response?.ok || !response.body) throw new SetupError(`Download failed: HTTP ${response?.status ?? 0}`);
  const hash = createHash('sha256');
  let size = 0;
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_DOWNLOAD) {
        callback(new SetupError('Download exceeds 1 GiB.'));
        return;
      }
      hash.update(chunk);
      onBytes(size);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), hasher, createWriteStream(dest));
  const actual = hash.digest('hex');
  if (actual !== asset.sha256) {
    rmSync(dest, { force: true });
    throw new SetupError(`SHA-256 mismatch: downloaded ${actual}, expected ${asset.sha256}.`);
  }
}

function pickEngine(choice: string, installed: readonly EngineInstallation[]): EngineInstallation | undefined {
  const normalized = choice.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return (
    installed.find((item) => item.identifier.toLowerCase() === choice.trim().toLowerCase()) ??
    installed.find((item) => item.root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === normalized)
  );
}

function keyFor(root: string): string {
  return normalize(root);
}

function normalize(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new SetupError('Cancelled.');
}
