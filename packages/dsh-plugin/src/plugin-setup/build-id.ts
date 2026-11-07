/**
 * How a precompiled plugin is accepted by the editor.
 *
 * UBT writes `Binaries/<Platform>/UnrealEditor.modules` next to the plugin
 * DLLs and the same kind of manifest next to the editor binary
 * (`Engine/Binaries/<Platform>/UnrealEditor.modules`). The editor loads a
 * precompiled module only when those BuildId strings match. That is the check
 * recorded for the 5.8.1 package ("Plugin versus installed engine module
 * BuildId | Matched").
 *
 * Build.version has two different integers, Changelist and
 * CompatibleChangelist. On the published 5.8.1 zip the module BuildId
 * (55116800) is not the changelist named in the validation note (56057345).
 * This module therefore does not treat either field as the BuildId. They are
 * reported beside the comparison so a mismatch is diagnosable, and they never
 * promote a package whose module manifest was not actually compared.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BuildVersionFile {
  major: number;
  minor: number;
  patch: number;
  changelist?: number;
  compatibleChangelist?: number;
  branch?: string;
}

export interface ModuleManifest {
  buildId?: string;
  modules: Record<string, string>;
  /** Path the manifest was read from. */
  path: string;
}

export type BuildIdVerdict =
  | {
      status: 'match';
      pluginBuildId: string;
      engineBuildId: string;
      note: string;
    }
  | {
      status: 'mismatch';
      pluginBuildId?: string;
      engineBuildId?: string;
      note: string;
    }
  | {
      status: 'unverified';
      pluginBuildId?: string;
      engineBuildId?: string;
      note: string;
    };

export function readBuildVersion(engineRoot: string): BuildVersionFile | undefined {
  const path = join(engineRoot, 'Engine', 'Build', 'Build.version');
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      MajorVersion?: number;
      MinorVersion?: number;
      PatchVersion?: number;
      Changelist?: number;
      CompatibleChangelist?: number;
      BranchName?: string;
    };
    if (typeof raw.MajorVersion !== 'number' || typeof raw.MinorVersion !== 'number') return undefined;
    return {
      major: raw.MajorVersion,
      minor: raw.MinorVersion,
      patch: typeof raw.PatchVersion === 'number' ? raw.PatchVersion : 0,
      ...(typeof raw.Changelist === 'number' ? { changelist: raw.Changelist } : {}),
      ...(typeof raw.CompatibleChangelist === 'number'
        ? { compatibleChangelist: raw.CompatibleChangelist }
        : {}),
      ...(raw.BranchName ? { branch: raw.BranchName } : {}),
    };
  } catch {
    return undefined;
  }
}

export function formatEngineVersion(version: BuildVersionFile | undefined): string | undefined {
  if (!version) return undefined;
  const branch = version.branch ? ` (${version.branch})` : '';
  return `${version.major}.${version.minor}.${version.patch}${branch}`;
}

/** Editor-target module manifest. Other targets (Game, Server) are not the editor's id. */
export function modulesPath(root: string, platform: string): string {
  return join(root, 'Binaries', platform, 'UnrealEditor.modules');
}

export function readModuleManifest(path: string): ModuleManifest | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      BuildId?: unknown;
      Modules?: Record<string, unknown>;
    };
    const modules: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.Modules ?? {})) {
      if (typeof value === 'string') modules[key] = value;
    }
    return {
      ...(typeof raw.BuildId === 'string' && raw.BuildId.length > 0 ? { buildId: raw.BuildId } : {}),
      modules,
      path,
    };
  } catch {
    return undefined;
  }
}

export function engineEditorManifest(engineRoot: string, platform: string): ModuleManifest | undefined {
  return readModuleManifest(join(engineRoot, 'Engine', 'Binaries', platform, 'UnrealEditor.modules'));
}

/**
 * Compare the plugin manifest with the editor's own manifest.
 * Missing either side is unverified, not a match and not a guessed changelist.
 */
export function compareBuildIds(
  plugin: ModuleManifest | undefined,
  engine: ModuleManifest | undefined,
): BuildIdVerdict {
  if (!plugin?.buildId && !engine?.buildId) {
    return {
      status: 'unverified',
      note:
        'Neither the plugin nor the editor has an UnrealEditor.modules BuildId, so binary compatibility was not established.',
    };
  }
  if (!plugin?.buildId) {
    return {
      status: 'unverified',
      ...(engine?.buildId ? { engineBuildId: engine.buildId } : {}),
      note: 'The package has no UnrealEditor.modules BuildId to compare with the editor.',
    };
  }
  if (!engine?.buildId) {
    return {
      status: 'unverified',
      pluginBuildId: plugin.buildId,
      note:
        'The editor has no Engine/Binaries UnrealEditor.modules BuildId. ' +
        'Build.version Changelist and CompatibleChangelist are not substitutes for that manifest.',
    };
  }
  if (plugin.buildId === engine.buildId) {
    return {
      status: 'match',
      pluginBuildId: plugin.buildId,
      engineBuildId: engine.buildId,
      note: 'Plugin and editor UnrealEditor.modules BuildId match.',
    };
  }
  return {
    status: 'mismatch',
    pluginBuildId: plugin.buildId,
    engineBuildId: engine.buildId,
    note:
      `Plugin BuildId ${plugin.buildId} does not match editor BuildId ${engine.buildId}. ` +
      'The package is not installed.',
  };
}
