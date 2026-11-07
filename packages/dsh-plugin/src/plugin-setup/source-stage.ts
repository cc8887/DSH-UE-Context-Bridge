/**
 * Stage a source checkout the way Scripts/Stage-Ue58Plugin.ps1 does, without
 * invoking PowerShell.
 *
 * The base descriptor stays free of the UE 5.8 MCP modules so older engines
 * still compile. For 5.8.x only, MCP/Source is copied in and the descriptor
 * gains those modules plus their engine-plugin dependencies. That edits the
 * staged GeneralBlueprint.uplugin only. It does not modify the engine's
 * ModelContextProtocol plugin.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BuildVersionFile } from './build-id.ts';

const EXCLUDE = new Set([
  '.git',
  '.buildwork',
  'Binaries',
  'Intermediate',
  'Saved',
  'DerivedDataCache',
  'Artifacts',
  'Releases',
  'Dev',
  'MCP',
]);

interface DescriptorModule {
  Name?: string;
  [key: string]: unknown;
}

interface Descriptor {
  Modules?: DescriptorModule[];
  Plugins?: Array<{ Name?: string; Enabled?: boolean; [key: string]: unknown }>;
  [key: string]: unknown;
}

export function stageSourceTree(checkout: string, destination: string, version: BuildVersionFile): void {
  if (existsSync(destination)) throw new Error(`staging destination already exists: ${destination}`);
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(checkout, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name) || entry.name === '.gitignore') continue;
    cpSync(join(checkout, entry.name), join(destination, entry.name), {
      recursive: true,
      dereference: false,
      filter: (source) => {
        const base = source.slice(checkout.length).split(/[\\/]/).filter(Boolean)[0];
        return !base || !EXCLUDE.has(base);
      },
    });
  }
  if (!existsSync(join(destination, 'GeneralBlueprint.uplugin'))) {
    throw new Error('staged checkout has no GeneralBlueprint.uplugin');
  }
  if (version.major === 5 && version.minor === 8) mergeMcp(checkout, destination);
}

function mergeMcp(checkout: string, destination: string): void {
  const mcpPath = join(checkout, 'MCP', 'GeneralBlueprintMCP.uplugin');
  if (!existsSync(mcpPath)) throw new Error('UE 5.8 source staging requires MCP/GeneralBlueprintMCP.uplugin');
  const mcp = JSON.parse(readFileSync(mcpPath, 'utf8')) as Descriptor;
  const descriptorPath = join(destination, 'GeneralBlueprint.uplugin');
  const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) as Descriptor;
  for (const module of mcp.Modules ?? []) {
    const name = module.Name;
    if (!name) throw new Error('MCP descriptor has a module without a name');
    const sourceModule = join(checkout, 'MCP', 'Source', name);
    if (!existsSync(join(sourceModule, `${name}.Build.cs`))) {
      throw new Error(`MCP module source is missing: ${sourceModule}`);
    }
    const staged = join(destination, 'Source', name);
    mkdirSync(staged, { recursive: true });
    cpSync(sourceModule, staged, { recursive: true, dereference: false });
    descriptor.Modules = [...(descriptor.Modules ?? []).filter((item) => item.Name !== name), module];
  }
  for (const dependency of mcp.Plugins ?? []) {
    if (!dependency.Name || dependency.Name === 'GeneralBlueprint') continue;
    descriptor.Plugins = [
      ...(descriptor.Plugins ?? []).filter((item) => item.Name !== dependency.Name),
      dependency,
    ];
  }
  writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
}
