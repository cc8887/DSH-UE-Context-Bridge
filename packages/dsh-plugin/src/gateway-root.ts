/**
 * gateway-root.ts — locate the gateway package at runtime.
 *
 * The bundle patch must stay free of absolute paths, or it stops working the
 * moment the clone moves or another machine installs it. So instead of a
 * baked-in `gatewayCwd`, the plugin walks up from its own module and finds the
 * gateway by shape: the directory that contains `src/main.ts`.
 *
 * That single rule covers both layouts without configuration:
 *
 *   installed   <profile>/node_modules/@ue-bridge/gateway/src/main.ts
 *   from a clone <repo>/packages/gateway/src/main.ts
 *
 * Node resolves the gateway's own `@ue-bridge/contracts/*` imports by walking
 * up to the profile's node_modules, so the gateway works the same either way.
 */

import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Where to look for the gateway, relative to each ancestor of this module. */
const CANDIDATE_GATEWAY_DIRS = ['gateway', join('packages', 'gateway')] as const;

export interface GatewayLocation {
  /** Directory to run the gateway in: the gateway package root. */
  readonly cwd: string;
  /** Gateway entrypoint, relative to `cwd`. */
  readonly main: string;
}

/**
 * Resolve the gateway from this module's own location.
 *
 * @param fromModuleUrl - `import.meta.url` of the calling module.
 * @returns the gateway location, or undefined when no gateway is installed
 *   beside the plugin (a deployment that ships the plugin without the gateway).
 */
export function resolveGatewayLocation(
  fromModuleUrl: string = import.meta.url,
): GatewayLocation | undefined {
  let dir = dirname(fileURLToPath(fromModuleUrl));
  // Walk to the filesystem root; a clone or a profile is never deeper than
  // this, and stopping early would miss a valid parent layout.
  for (;;) {
    for (const candidate of CANDIDATE_GATEWAY_DIRS) {
      const root = resolve(dir, candidate);
      const main = join(root, 'src', 'main.ts');
      if (existsSync(main)) return { cwd: root, main: 'src/main.ts' };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
