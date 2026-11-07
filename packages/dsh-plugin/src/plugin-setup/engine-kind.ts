/**
 * Launcher versus source, from the signals Unreal itself writes.
 *
 * A single file is not enough, and the directory path is not a signal at all
 * ("Epic Games" in a path does not make a build a launcher install). When the
 * signals disagree, or none of them are present, the result is ambiguous and
 * the setup UI has to be told which one this engine is.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineInstallation, EngineResolution } from '../toolchain.ts';

export type EngineKind = 'launcher' | 'source' | 'ambiguous';

export interface KindClassification {
  kind: EngineKind;
  signals: string[];
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function classifyEngineKind(engineRoot: string, installations: readonly EngineInstallation[]): KindClassification {
  const signals: string[] = [];
  const launcher: string[] = [];
  const source: string[] = [];

  if (existsSync(join(engineRoot, 'Engine', 'Build', 'InstalledBuild.txt'))) {
    launcher.push('Engine/Build/InstalledBuild.txt');
  }
  if (existsSync(join(engineRoot, 'Engine', 'Build', 'SourceDistribution.txt'))) {
    source.push('Engine/Build/SourceDistribution.txt');
  }

  const rootKey = engineRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  for (const install of installations) {
    const key = install.root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (key !== rootKey) continue;
    if (install.via === 'launcher') launcher.push(`launcher manifest ${install.identifier}`);
    else if (GUID.test(install.identifier)) source.push(`registry source build ${install.identifier}`);
    else signals.push(`registry identifier ${install.identifier} (not used as launcher or source by itself)`);
  }

  signals.push(...launcher.map((item) => `launcher: ${item}`), ...source.map((item) => `source: ${item}`));
  if (launcher.length > 0 && source.length > 0) return { kind: 'ambiguous', signals };
  if (launcher.length > 0) return { kind: 'launcher', signals };
  if (source.length > 0) return { kind: 'source', signals };
  if (signals.length === 0) signals.push('no InstalledBuild.txt, SourceDistribution.txt, or launcher/registry record');
  return { kind: 'ambiguous', signals };
}

/**
 * Whether setup may act on this engine without asking again.
 *
 * Same gate as editor selection: a recorded choice, an EngineAssociation hit,
 * or an explicit root. An engine merely found above the project is not enough.
 * Linux source trees ship Build.sh instead of Build.bat, so either build
 * entry counts; a Windows launcher tree still has Build.bat.
 */
export function engineIsDecided(engine: EngineResolution, recorded: boolean): boolean {
  if (!engine.engineRoot || !engine.validRootDirectory) return false;
  if (recorded) return true;
  if (engine.source !== 'config' && engine.source !== 'association' && engine.source !== 'association-path') {
    return false;
  }
  if (engine.buildBatFound) return true;
  return existsSync(join(engine.engineRoot, 'Engine', 'Build', 'BatchFiles', 'Linux', 'Build.sh'));
}

export function projectPluginDir(projectRoot: string): string {
  return join(projectRoot, 'Plugins', 'GeneralBlueprint');
}

export function enginePluginDir(engineRoot: string): string {
  return join(engineRoot, 'Engine', 'Plugins', 'GeneralBlueprint');
}
