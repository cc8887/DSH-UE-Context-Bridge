/**
 * toolchain.ts — engine discovery and build-environment checks.
 *
 * Everything here mirrors what Unreal itself does, because every hand-rolled
 * guess about "where is the engine" eventually breaks. The three mechanisms:
 *
 *   Which engines exist on this machine?
 *     FDesktopPlatformWindows::EnumerateEngineInstallations — the union of
 *       * the launcher manifest
 *         %ProgramData%/Epic/UnrealEngineLauncher/LauncherInstalled.dat,
 *         keeping entries whose AppName starts with "UE_" and stripping the
 *         prefix ("UE_5.6" -> "5.6")
 *       * every value under HKCU\SOFTWARE\Epic Games\Unreal Engine\Builds,
 *         where each value name is an identifier (a GUID for source builds)
 *         and its data is the engine root
 *     Every candidate is accepted only if IsValidRootDirectory passes, and
 *     duplicates collapse by directory. This is the list the "Generate Visual
 *     Studio project files" shell extension offers to pick from.
 *
 *   Is a directory really an engine root?
 *     FDesktopPlatformBase::IsValidRootDirectory — both Engine/Binaries and
 *     Engine/Build exist. Deliberately not Build.bat: the point of the second
 *     check is to reject a tree that looks engine-like but cannot build code.
 *
 *   Which engine does this project want?
 *     FDesktopPlatformBase::GetEngineIdentifierForProject — EngineAssociation
 *     first, either a path or an identifier into the installed list; when the
 *     association is empty, walk up the parent directories looking for an
 *     engine root. Source-tree projects carry an empty association on purpose,
 *     so the project file stays portable across machines (SetEngineIdentifier-
 *     ForProject blanks it for exactly this reason).
 *
 *   Can it build?
 *     UnrealBuildTool -Mode=ValidatePlatforms, which prints
 *     `##PlatformValidate: Win64 VALID <sdk>` without building anything. That
 *     is UBT's verdict on the toolchain, including the MSVC version check
 *     whose failure otherwise only surfaces minutes into a real build.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { diagnoseWindowsToolchain } from './windows-toolchain.ts';

const execFileAsync = promisify(execFile);

const BUILDS_KEY = 'SOFTWARE\\Epic Games\\Unreal Engine\\Builds';
/** Relative to %ProgramData%/Epic/ — see FWindowsPlatformProcess::ApplicationSettingsDir. */
const LAUNCHER_LIST = join('Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat');

/** Run a command and capture combined output. Resolves, never rejects. */
function run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise) => {
    // On Windows a .bat is not an executable; it must go through cmd, or
    // spawn fails with EINVAL. Same reason as in editor-lifecycle.ts.
    const isBatch = /\.bat$/i.test(command);
    const launch = isBatch
      ? { command: 'cmd.exe', args: ['/c', command, ...args] }
      : { command, args };
    const child = spawn(launch.command, launch.args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: string[] = [];
    child.stdout?.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
    child.on('error', (err: Error) => chunks.push(`spawn error: ${err.message}`));
    setTimeout(() => child.kill(), timeoutMs).unref?.();
    child.on('close', () => resolvePromise(chunks.join('')));
  });
}

/** UE's NormalizeDirectoryName + CollapseRelativeDirectories, enough for compares. */
function normalizeDir(path: string): string {
  let n = resolve(path).replace(/\\/g, '/');
  while (n.length > 2 && n.endsWith('/')) n = n.slice(0, -1);
  return n;
}

function sameDir(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * FDesktopPlatformBase::IsValidRootDirectory.
 *
 * Engine/Binaries must exist, and Engine/Build must exist. The comment in UE
 * is explicit that the second check filters out "anything that has an
 * engine-like directory structure but doesn't allow building code".
 */
export function isValidRootDirectory(root: string): boolean {
  return existsSync(join(root, 'Engine', 'Binaries')) && existsSync(join(root, 'Engine', 'Build'));
}

/** FDesktopPlatformBase::IsSourceDistribution. */
export function isSourceDistribution(root: string): boolean {
  return existsSync(join(root, 'Engine', 'Build', 'SourceDistribution.txt'));
}

/** TryGetEngineVersion, from Engine/Build/Build.version. */
export function readEngineVersion(root: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'Engine', 'Build', 'Build.version'), 'utf8')) as {
      MajorVersion?: number;
      MinorVersion?: number;
      PatchVersion?: number;
      BranchName?: string;
    };
    if (typeof raw.MajorVersion !== 'number' || typeof raw.MinorVersion !== 'number') return undefined;
    const patch = typeof raw.PatchVersion === 'number' ? `.${raw.PatchVersion}` : '';
    const branch = raw.BranchName ? ` (${raw.BranchName})` : '';
    return `${raw.MajorVersion}.${raw.MinorVersion}${patch}${branch}`;
  } catch {
    return undefined;
  }
}

export interface EngineInstallation {
  /** UE's identifier: "5.6" for a launcher release, a GUID for a source build. */
  identifier: string;
  root: string;
  /** Where this entry came from. */
  via: 'launcher' | 'registry';
  /** From Engine/Build/Build.version, when readable. */
  version?: string;
  /** True for a source build (Engine/Build/SourceDistribution.txt present). */
  sourceDistribution: boolean;
}

/** FDesktopPlatformBase::EnumerateLauncherEngineInstallations. */
function readLauncherInstallations(): Array<{ identifier: string; root: string }> {
  const programData = process.env.ProgramData ?? 'C:\\ProgramData';
  const file = join(programData, LAUNCHER_LIST);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      InstallationList?: Array<{ AppName?: string; InstallLocation?: string }>;
    };
    const out: Array<{ identifier: string; root: string }> = [];
    for (const item of parsed.InstallationList ?? []) {
      const appName = item.AppName;
      const location = item.InstallLocation;
      // Only engine installs; "FabPlugin_5.6" and "QuixelBridge_5.1" share the
      // same directories and are not engines. UE strips the prefix case-
      // sensitively, which is what makes the identifier a version string.
      if (!appName?.startsWith('UE_') || !location) continue;
      out.push({ identifier: appName.slice(3), root: normalizeDir(location) });
    }
    return out;
  } catch {
    return [];
  }
}

/** The per-user half of FDesktopPlatformWindows::EnumerateEngineInstallations. */
async function readRegistryBuilds(): Promise<Array<{ identifier: string; root: string }>> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('reg.exe', ['query', `HKCU\\${BUILDS_KEY}`], {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch {
    // Key absent, or no registry access: there are simply no source builds.
    return [];
  }
  const out: Array<{ identifier: string; root: string }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s{2,}(\S+)\s+REG_\w+\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const identifier = match[1];
    if (identifier === '(Default)') continue;
    const root = match[2].replace(/["']/g, '').trim();
    if (!root || root === '(value not set)') continue;
    out.push({ identifier, root: normalizeDir(root) });
  }
  return out;
}

/**
 * Every engine installation UE would offer for this machine.
 *
 * Launcher releases come first so that, when the same directory is registered
 * both ways, the version-string identifier wins — matching UE's own ordering,
 * which seeds the dedupe set from the launcher list before adding registry
 * entries.
 */
export async function enumerateEngineInstallations(): Promise<EngineInstallation[]> {
  const launcher = readLauncherInstallations();
  const registry = await readRegistryBuilds();

  const byDir = new Map<string, EngineInstallation>();
  for (const [via, entries] of [
    ['launcher', launcher],
    ['registry', registry],
  ] as const) {
    for (const entry of entries) {
      if (!isValidRootDirectory(entry.root)) continue;
      const key = entry.root.toLowerCase();
      if (byDir.has(key)) continue;
      byDir.set(key, {
        identifier: entry.identifier,
        root: entry.root,
        via,
        ...(() => {
          const version = readEngineVersion(entry.root);
          return version ? { version } : {};
        })(),
        sourceDistribution: isSourceDistribution(entry.root),
      });
    }
  }
  return [...byDir.values()];
}

/**
 * NativeProjectsBase::EnumerateProjectFiles, for one engine root.
 *
 * UE decides whether a project is "native" to an engine by reading every
 * *.uprojectdirs file in the engine root and scanning each listed directory
 * one level deep. That is the real test, and it is the opposite direction
 * from guessing an engine by walking up out of the project.
 */
export function enumerateNativeProjects(engineRoot: string): string[] {
  const root = normalizeDir(engineRoot);
  const baseDirs: string[] = [];
  let rootFiles: string[];
  try {
    rootFiles = readdirSync(root);
  } catch {
    return [];
  }
  for (const name of rootFiles) {
    if (!name.endsWith('.uprojectdirs')) continue;
    let lines: string[];
    try {
      lines = readFileSync(join(root, name), 'utf8').split(/\r?\n/);
    } catch {
      continue;
    }
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith(';')) continue;
      const base = normalizeDir(join(root, line));
      // UE ignores any search path that escapes the engine root.
      if (!sameDir(base, root) && !base.toLowerCase().startsWith(root.toLowerCase() + '/')) continue;
      baseDirs.push(base);
    }
  }

  const projects: string[] = [];
  for (const base of baseDirs) {
    let subDirs: string[];
    try {
      subDirs = readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const sub of subDirs) {
      if (sub.startsWith('.')) continue;
      let files: string[];
      try {
        files = readdirSync(join(base, sub));
      } catch {
        continue;
      }
      for (const file of files) {
        if (file.endsWith('.uproject')) projects.push(normalizeDir(join(base, sub, file)));
      }
    }
  }
  return projects;
}

export interface EngineResolution {
  /** How the engine root was found, in UE's own terms. */
  source:
    | 'config'
    /** EngineAssociation named an installed engine (launcher release or GUID). */
    | 'association'
    /** EngineAssociation held a path rather than an identifier. */
    | 'association-path'
    /** No association; an engine root was found by walking up from the project. */
    | 'parent-directory'
    | 'unresolved';
  engineRoot?: string;
  /** The raw EngineAssociation value from the .uproject. */
  association?: string;
  /** UE's identifier for the resolved engine, when it is a known install. */
  identifier?: string;
  /** From Engine/Build/Build.version. */
  engineVersion?: string;
  sourceDistribution?: boolean;
  /** UE's own native/foreign test, via .uprojectdirs. */
  native?: boolean;
  /** IsValidRootDirectory: UE's test for "this really is an engine root". */
  validRootDirectory: boolean;
  /** True when Build.bat exists under the resolved root, i.e. UBT is runnable. */
  buildBatFound: boolean;
  /** Why resolution failed, when it did. */
  reason?: string;
}

export interface ToolchainStatus {
  platform: string;
  /** UBT's own verdict. */
  valid: boolean;
  /** SDK version string UBT reported, when -OutputSDKs was used. */
  sdk?: string;
  /** Raw UBT line, kept so an unparsed output is still visible. */
  raw?: string;
  /** Set when UBT could not be run at all. */
  error?: string;
  /**
   * Compiler diagnosis, attached when the failure looks like the compiler
   * the config asks for is not installed. UBT's own message names an enum
   * value ("Requested value 'VisualStudio2019' was not found") without
   * saying which config file supplied it or what is installed instead, so
   * without this the operator has nothing to act on.
   */
  compiler?: import('./windows-toolchain.ts').ToolchainDiagnosis;
}

/**
 * Resolve the engine root for a project.
 *
 * `explicit` wins when given: an operator who configured a path means that
 * path. Otherwise this follows GetEngineIdentifierForProject.
 */
export async function resolveEngineRoot(
  projectRoot: string,
  uproject: { EngineAssociation?: string } | undefined,
  explicit?: string,
  uprojectPath?: string,
): Promise<EngineResolution> {
  if (explicit) {
    const root = normalizeDir(explicit);
    const valid = isValidRootDirectory(root);
    const bat = join(root, 'Engine', 'Build', 'BatchFiles', 'Build.bat');
    return {
      source: 'config',
      engineRoot: root,
      validRootDirectory: valid,
      buildBatFound: existsSync(bat),
      ...(readEngineVersion(root) ? { engineVersion: readEngineVersion(root) } : {}),
      sourceDistribution: isSourceDistribution(root),
      ...(valid ? {} : { reason: `not a valid engine root: missing Engine/Binaries or Engine/Build under ${root}` }),
    };
  }

  const installations = await enumerateEngineInstallations();

  // An empty association is what source-tree projects carry; treat it as
  // absent rather than as a key to look up.
  const association = uproject?.EngineAssociation?.trim();
  if (association) {
    // A path means the .uproject points straight at a source build. UE
    // resolves it against the project directory and then converts it back
    // into an identifier.
    if (association.includes('/') || association.includes('\\')) {
      const root = normalizeDir(resolve(projectRoot, association));
      const known = installations.find((i) => sameDir(i.root, root));
      const valid = isValidRootDirectory(root);
      return {
        source: 'association-path',
        engineRoot: root,
        association,
        ...(known?.identifier ? { identifier: known.identifier } : {}),
        validRootDirectory: valid,
        buildBatFound: existsSync(join(root, 'Engine', 'Build', 'BatchFiles', 'Build.bat')),
        ...(readEngineVersion(root) ? { engineVersion: readEngineVersion(root) } : {}),
        sourceDistribution: isSourceDistribution(root),
        ...(valid ? {} : { reason: `EngineAssociation path ${root} is not a valid engine root` }),
      };
    }

    // Otherwise it is a GUID (source build) or a version string (launcher).
    const match = installations.find((i) => i.identifier.toLowerCase() === association.toLowerCase());
    if (match) {
      return {
        source: 'association',
        engineRoot: match.root,
        association,
        identifier: match.identifier,
        validRootDirectory: true,
        buildBatFound: existsSync(join(match.root, 'Engine', 'Build', 'BatchFiles', 'Build.bat')),
        ...(match.version ? { engineVersion: match.version } : {}),
        sourceDistribution: match.sourceDistribution,
        ...(uprojectPath ? { native: isNativeTo(uprojectPath, match.root) } : {}),
      };
    }

    return {
      source: 'unresolved',
      association,
      validRootDirectory: false,
      buildBatFound: false,
      reason:
        `EngineAssociation '${association}' matches no installed engine. ` +
        `Known: ${installations.map((i) => i.identifier).join(', ') || '(none)'}. ` +
        `Run the engine's register step, or set engineRoot.`,
    };
  }

  // No association: UE scans up the directory hierarchy for an installation.
  // The walk ends at the filesystem root, which is the only bound needed.
  let dir = normalizeDir(projectRoot);
  for (;;) {
    const parent = normalizeDir(dirname(dir));
    if (sameDir(parent, dir)) break;
    dir = parent;
    if (!isValidRootDirectory(dir)) continue;
    const known = installations.find((i) => sameDir(i.root, dir));
    return {
      source: 'parent-directory',
      engineRoot: dir,
      ...(known?.identifier ? { identifier: known.identifier } : {}),
      validRootDirectory: true,
      buildBatFound: existsSync(join(dir, 'Engine', 'Build', 'BatchFiles', 'Build.bat')),
      ...(known?.version ? { engineVersion: known.version } : {}),
      sourceDistribution: isSourceDistribution(dir),
      ...(uprojectPath ? { native: isNativeTo(uprojectPath, dir) } : {}),
    };
  }

  return {
    source: 'unresolved',
    validRootDirectory: false,
    buildBatFound: false,
    reason:
      'Project has no EngineAssociation and no engine root above it. ' +
      `Installed engines: ${installations.map((i) => `${i.identifier}@${i.root}`).join(', ') || '(none)'}. ` +
      'Set engineRoot to one of them.',
  };
}

/** Is this project one the engine itself indexes via .uprojectdirs? */
function isNativeTo(uprojectPath: string, engineRoot: string): boolean {
  const target = normalizeDir(uprojectPath);
  return enumerateNativeProjects(engineRoot).some((p) => sameDir(p, target));
}

/**
 * Ask UBT whether the platform can build.
 *
 * Uses -Mode=ValidatePlatforms: it reports the toolchain verdict without
 * building anything, so it is cheap enough to run before every build.
 */
export async function validateToolchain(
  engineRoot: string,
  platform = 'Win64',
): Promise<ToolchainStatus> {
  const bat = join(engineRoot, 'Engine', 'Build', 'BatchFiles', 'Build.bat');
  if (!existsSync(bat)) {
    return { platform, valid: false, error: `Build.bat not found at ${bat}` };
  }

  try {
    const output = await run(
      bat,
      ['-Mode=ValidatePlatforms', `-Platforms=${platform}`, '-OutputSDKs'],
      engineRoot,
      180_000,
    );
    const line = output
      .split(/\r?\n/)
      .find((l) => l.includes('##PlatformValidate:') && l.includes(platform));
    if (!line) {
      return {
        platform,
        valid: false,
        ...{ raw: output.split(/\r?\n/).slice(-6).join('\n') },
        error: 'UBT produced no platform validation line',
      };
    }
    const match = /##PlatformValidate:\s*(\S+)\s+(VALID|INVALID)\s*(\S*)/.exec(line);
    if (!match) {
      return { platform, valid: false, ...{ raw: line }, error: 'unparsable platform validation line' };
    }
    return {
      platform: match[1],
      valid: match[2] === 'VALID',
      ...(match[3] ? { sdk: match[3] } : {}),
      ...{ raw: line.trim() },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status: ToolchainStatus = { platform, valid: false, error: message };

    // "Requested value 'X' was not found" is UBT failing to parse a
    // <Compiler> from BuildConfiguration.xml into its WindowsCompiler enum.
    // Attaching the diagnosis turns that into "this file, these fixes".
    if (/Requested value '[^']+' was not found/i.test(message)) {
      status.compiler = diagnoseWindowsToolchain(engineRoot);
    }
    return status;
  }
}
