/**
 * Enable GeneralBlueprint in the project descriptor.
 *
 * Only this plugin's row is added or updated. ModelContextProtocol and every
 * other row are left as they were. The previous file is copied beside the
 * project, outside Plugins/, before the write. A descriptor that is not JSON
 * is refused rather than rewritten.
 */

import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_NAME } from './constants.ts';

interface PluginRow {
  Name?: string;
  Enabled?: boolean;
  [key: string]: unknown;
}

interface UProject {
  Plugins?: PluginRow[];
  [key: string]: unknown;
}

export function findUproject(projectRoot: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(projectRoot);
  } catch {
    return undefined;
  }
  const hit = names.find((name) => name.endsWith('.uproject'));
  return hit ? join(projectRoot, hit) : undefined;
}

export function enablePluginInUproject(uprojectPath: string, backupPath: string): { changed: boolean } {
  const raw = readFileSync(uprojectPath, 'utf8').replace(/^\uFEFF/, '');
  let parsed: UProject;
  try {
    parsed = JSON.parse(raw) as UProject;
  } catch (error) {
    throw new Error(
      `Cannot enable ${PLUGIN_NAME}: ${uprojectPath} is not JSON (${error instanceof Error ? error.message : String(error)}). Enable it manually.`,
    );
  }
  const plugins = Array.isArray(parsed.Plugins) ? [...parsed.Plugins] : [];
  const index = plugins.findIndex((row) => row?.Name === PLUGIN_NAME);
  if (index >= 0 && plugins[index]?.Enabled === true) return { changed: false };
  if (index >= 0) plugins[index] = { ...plugins[index], Name: PLUGIN_NAME, Enabled: true };
  else plugins.push({ Name: PLUGIN_NAME, Enabled: true });
  parsed.Plugins = plugins;
  if (!existsSync(backupPath)) copyFileSync(uprojectPath, backupPath);
  writeFileSync(uprojectPath, `${JSON.stringify(parsed, null, 4)}\n`, 'utf8');
  return { changed: true };
}
