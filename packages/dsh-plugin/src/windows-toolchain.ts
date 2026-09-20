/**
 * Windows compiler toolchain discovery and diagnosis.
 *
 * Why this exists: UBT picks its compiler from a layered set of
 * BuildConfiguration.xml files, and a stale user-level entry silently beats a
 * correct engine-level one. On this machine that produced
 *   ArgumentException: Requested value 'VisualStudio2019' was not found
 * even though the engine's own Engine/Saved config correctly said
 * VisualStudio2026 and VS 18 Insiders was installed. The failure is invisible
 * until a build is actually attempted, and the message names an enum value
 * rather than the file that supplied it, so it does not say where to look.
 *
 * This module answers the two questions that message leaves open: which
 * Visual Studios are actually installed, and which config file is demanding
 * the one that is missing.
 *
 * Precedence, from Engine/Source/Programs/UnrealBuildTool/Configuration/Xml/
 * XmlConfig.cs: Engine (NotForLicensees) -> Engine (Saved) -> Global
 * (ProgramData) -> Global (AppData) -> Global (LocalAppData) -> Global
 * (Documents). Later files override earlier ones, so AppData beats Engine
 * (Saved) — the opposite of what the file order in a listing suggests.
 *
 * Version mapping, from MicrosoftPlatformSDK.cs: any installation at or above
 * MinimumVisualStudio2026Version is treated as VisualStudio2026, "until we
 * have an explicit enum for them". So VS 18 Insiders is a legal compiler for
 * this engine; it is VisualStudio2019 that has no installation behind it.
 *
 * Diagnosis only. Nothing here edits a user's config — resolving a conflict
 * is a human decision about their machine.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

/** The compiler enum values UBT accepts, newest last. */
export const WINDOWS_COMPILERS = [
  'VisualStudio2019',
  'VisualStudio2022',
  'VisualStudio2026',
] as const;

export type WindowsCompiler = (typeof WINDOWS_COMPILERS)[number];

export interface VisualStudioInstallation {
  /** Directory name under Microsoft Visual Studio: 2022, 18, ... */
  id: string;
  /** Community / Professional / Enterprise / Insiders. */
  edition: string;
  /** Full version, e.g. 18.0.11001.1. */
  version?: string;
  path: string;
  /** Which VisualStudio20xx enum value UBT would map this to, if any. */
  compiler?: WindowsCompiler;
  /** True when the install cannot back a build (prerelease-only, no VC tools). */
  unsupported?: boolean;
  reason?: string;
}

export interface CompilerSetting {
  compiler: string;
  /** Present in the wild alongside Compiler; pins an exact toolset build. */
  compilerVersion?: string;
}

export interface ToolchainConfigFile {
  /** Which layer of UBT's config chain this is. */
  layer: string;
  path: string;
  exists: boolean;
  setting?: CompilerSetting;
}

export interface ToolchainDiagnosis {
  ok: boolean;
  /** What UBT will actually be told to use, after the layers are applied. */
  effective?: CompilerSetting;
  /** The file that supplied the effective value. */
  effectiveFrom?: string;
  /** Effective value that no installed VS can satisfy. */
  missing?: string;
  /** Installations UBT would consider usable. */
  usable: VisualStudioInstallation[];
  /** Installations present but not usable by this engine. */
  unusable: VisualStudioInstallation[];
  configs: ToolchainConfigFile[];
  /** Human-readable next steps; empty when ok. */
  fixes: string[];
}

/** UBT's config layers, in the order later ones override earlier ones. */
function configLayers(): ToolchainConfigFile[] {
  const appData = process.env['APPDATA'];
  const localAppData = process.env['LOCALAPPDATA'];
  const programData = process.env['ProgramData'];
  const documents = process.env['USERPROFILE']
    ? join(process.env['USERPROFILE'], 'Documents')
    : undefined;

  const layers: Array<{ layer: string; path?: string }> = [
    { layer: 'Engine (Saved)', path: engineRoot ? join(engineRoot, 'Engine', 'Saved', 'UnrealBuildTool', 'BuildConfiguration.xml') : undefined },
    { layer: 'Global (ProgramData)', path: programData ? join(programData, 'Unreal Engine', 'UnrealBuildTool', 'BuildConfiguration.xml') : undefined },
    { layer: 'Global (AppData)', path: appData ? join(appData, 'Unreal Engine', 'UnrealBuildTool', 'BuildConfiguration.xml') : undefined },
    { layer: 'Global (LocalAppData)', path: localAppData ? join(localAppData, 'Unreal Engine', 'UnrealBuildTool', 'BuildConfiguration.xml') : undefined },
    { layer: 'Global (Documents)', path: documents ? join(documents, 'Unreal Engine', 'UnrealBuildTool', 'BuildConfiguration.xml') : undefined },
  ];

  return layers
    .filter((l): l is { layer: string; path: string } => Boolean(l.path))
    .map((l) => {
      const file: ToolchainConfigFile = { layer: l.layer, path: l.path!, exists: existsSync(l.path!) };
      if (file.exists) {
        const setting = readCompilerSetting(l.path!);
        if (setting) file.setting = setting;
      }
      return file;
    });
}

// Engine root is optional context: when known, the engine-level layer is
// included in the chain, which is what makes the override visible.
let engineRoot: string | undefined;
export function setEngineRoot(root: string | undefined): void {
  engineRoot = root;
}

/**
 * Pull <WindowsPlatform><Compiler> out of a BuildConfiguration.xml.
 *
 * Regex rather than a full XML parse: these files are small, UBT itself reads
 * them leniently, and a parser would turn a malformed file into an exception
 * instead of a diagnosis. A file we cannot read simply reports no setting.
 */
export function readCompilerSetting(path: string): CompilerSetting | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const block = /<WindowsPlatform>([\s\S]*?)<\/WindowsPlatform>/i.exec(text);
  const scope = block ? block[1]! : text;
  const compiler = /<Compiler>\s*([^<\s]+)\s*<\/Compiler>/i.exec(scope);
  if (!compiler) return undefined;
  const version = /<CompilerVersion>\s*([^<\s]+)\s*<\/CompilerVersion>/i.exec(scope);
  return {
    compiler: compiler[1]!,
    ...(version ? { compilerVersion: version[1]! } : {}),
  };
}

/**
 * Map a VS installation version to the enum value UBT will use.
 *
 * Any version at or above the 2026 minimum is VisualStudio2026 — the engine
 * explicitly treats newer installs as 2026 until it adds an enum for them.
 */
export function compilerForVersion(version: string | undefined): WindowsCompiler | undefined {
  if (!version) return undefined;
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (!Number.isFinite(major)) return undefined;
  if (major >= 18) return 'VisualStudio2026';
  if (major >= 17) return 'VisualStudio2022';
  if (major >= 16) return 'VisualStudio2019';
  return undefined;
}

/**
 * Find installed Visual Studios.
 *
 * vswhere is the primary source because it reports the real installation
 * version, which is what UBT's mapping needs. Two of its behaviours matter
 * and are easy to get wrong:
 *
 *  - It EXCLUDES prerelease installs unless -prerelease is passed. On this
 *    machine that hid VS 18 Insiders entirely, which is a second, independent
 *    cause of "UBT cannot find my compiler".
 *  - Multi-property queries return nothing on vswhere 3.1.7, so properties
 *    are queried one at a time.
 *
 * Directory enumeration under %ProgramFiles%/Microsoft Visual Studio/<year>/
 * <edition> is the fallback when vswhere is absent or returns nothing, since
 * that layout is stable across every VS the engine supports. It yields the
 * year rather than the exact version, which is still enough to map to an enum
 * value, and it is marked as such via `versionFrom: 'layout'`.
 */
export function discoverVisualStudioInstallations(): VisualStudioInstallation[] {
  const fromWhere = discoverViaVswhere();
  if (fromWhere.length > 0) return fromWhere;
  return discoverViaLayout();
}

function vswherePath(): string | undefined {
  const base = process.env['ProgramFiles(x86)'] ?? process.env['ProgramFiles'];
  if (!base) return undefined;
  const candidate = join(base, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  return existsSync(candidate) ? candidate : undefined;
}

/** Run vswhere for one property; returns trimmed non-empty lines. */
function vswhereProperty(exe: string, property: string): string[] {
  try {
    const out = spawnSync(exe, ['-prerelease', '-nologo', '-property', property], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (out.status !== 0 || !out.stdout) return [];
    return out.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function discoverViaVswhere(): VisualStudioInstallation[] {
  const exe = vswherePath();
  if (!exe) return [];

  const paths = vswhereProperty(exe, 'installationPath');
  if (paths.length === 0) return [];
  const versions = vswhereProperty(exe, 'installationVersion');

  return paths.map((path, index) => {
    const version = versions[index];
    const compiler = compilerForVersion(version);
    const hasVcTools = existsSync(
      join(path, 'VC', 'Auxiliary', 'Build', 'Microsoft.VCToolsVersion.default.txt'),
    );
    return {
      id: basename(dirname(path)),
      edition: basename(path),
      path,
      ...(version ? { version } : {}),
      ...(compiler ? { compiler } : {}),
      ...(hasVcTools
        ? {}
        : {
            unsupported: true,
            reason: 'no VC tools installed (Microsoft.VCToolsVersion.default.txt missing)',
          }),
    };
  });
}

function discoverViaLayout(): VisualStudioInstallation[] {
  const roots = [
    process.env['ProgramFiles'] ? join(process.env['ProgramFiles'], 'Microsoft Visual Studio') : undefined,
    process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio') : undefined,
  ].filter((r): r is string => Boolean(r));

  const found: VisualStudioInstallation[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const id of safeReaddir(root)) {
      if (!/^\d{2,4}$/.test(id)) continue;
      const yearDir = join(root, id);
      for (const edition of safeReaddir(yearDir)) {
        const path = join(yearDir, edition);
        if (!existsSync(join(path, 'VC'))) continue;
        const key = path.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        // The directory year is the VS generation, not the exact version, but
        // it maps to the same enum value, which is all diagnosis needs.
        const compiler = compilerForVersion(`${id}.0`);
        const hasVcTools = existsSync(
          join(path, 'VC', 'Auxiliary', 'Build', 'Microsoft.VCToolsVersion.default.txt'),
        );
        found.push({
          id,
          edition,
          path,
          ...(compiler ? { compiler } : {}),
          ...(hasVcTools
            ? {}
            : {
                unsupported: true,
                reason: 'no VC tools installed (Microsoft.VCToolsVersion.default.txt missing)',
              }),
        });
      }
    }
  }
  return found;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Diagnose the Windows compiler toolchain.
 *
 * Reports the effective compiler after applying UBT's override order, whether
 * any installed VS can satisfy it, and which file to change if not.
 */
export function diagnoseWindowsToolchain(root?: string): ToolchainDiagnosis {
  if (root) setEngineRoot(root);
  const configs = configLayers();
  const installations = discoverVisualStudioInstallations();

  const usable: VisualStudioInstallation[] = [];
  const unusable: VisualStudioInstallation[] = [];
  for (const install of installations) {
    (install.unsupported || !install.compiler ? unusable : usable).push(install);
  }

  // Later layers override earlier ones, so the last file that sets a compiler
  // wins — that is the value UBT will act on.
  let effective: CompilerSetting | undefined;
  let effectiveFrom: string | undefined;
  for (const config of configs) {
    if (config.setting) {
      effective = config.setting;
      effectiveFrom = `${config.layer} (${config.path})`;
    }
  }

  const fixes: string[] = [];
  let missing: string | undefined;
  let ok = true;

  if (effective) {
    const wanted = effective.compiler;
    const satisfied = usable.some((i) => i.compiler === wanted);
    if (!satisfied) {
      ok = false;
      missing = wanted;
      const known = WINDOWS_COMPILERS.includes(wanted as WindowsCompiler);
      fixes.push(
        `BuildConfiguration asks for ${wanted} but no installed Visual Studio provides it.`,
      );
      if (effectiveFrom) {
        fixes.push(`That value comes from ${effectiveFrom}.`);
      }
      if (configs.filter((c) => c.setting).length > 1) {
        fixes.push(
          'More than one config file sets a compiler; the last layer wins, so an earlier correct value is being overridden.',
        );
      }
      if (!known) {
        fixes.push(
          `${wanted} is not a WindowsCompiler value this engine knows (${WINDOWS_COMPILERS.join(', ')}).`,
        );
      }
      if (usable.length > 0) {
        fixes.push(
          `Set <Compiler> to ${usable[0]!.compiler} (${usable[0]!.path}), or remove the <Compiler> line to let UBT auto-detect.`,
        );
      } else {
        fixes.push('No usable Visual Studio with VC tools was found; install the Desktop development with C++ workload.');
      }
    }
  } else if (usable.length === 0) {
    ok = false;
    fixes.push('No compiler configured and no usable Visual Studio found; install the Desktop development with C++ workload.');
  }

  return {
    ok,
    ...(effective ? { effective } : {}),
    ...(effectiveFrom ? { effectiveFrom } : {}),
    ...(missing ? { missing } : {}),
    usable,
    unusable,
    configs,
    fixes,
  };
}
