/**
 * Mode presets (plan section 1, 5.2 invariant 1).
 *
 * A preset fixes the model-visible UE surface for a whole session. Switching
 * mode starts a new session / explicit context boundary; there is no
 * per-turn dynamic routing.
 */

import type { ModeName } from '@ue-bridge/contracts/model-tools';

export interface PresetDefinition {
  readonly name: string;
  readonly mode: ModeName;
  /** Exact model-visible UE tool names, in registration order. */
  readonly ueTools: readonly string[];
  /** Native presentation; PTC SDK generation is never used in v0.1. */
  readonly presentation: 'native';
  /**
   * The preset inherits no shell and no raw UE MCP tools, so the announced
   * surface equals the callable surface.
   */
  readonly inheritsGlobalTools: false;
}

export const UE_DEFERRED_PRESET: PresetDefinition = {
  name: 'ue-deferred',
  mode: 'deferred',
  ueTools: ['ue_find', 'ue_call'],
  presentation: 'native',
  inheritsGlobalTools: false,
};

export const UE_PYTHON_PRESET: PresetDefinition = {
  name: 'ue-python',
  mode: 'python',
  ueTools: ['ue_python_execute'],
  presentation: 'native',
  inheritsGlobalTools: false,
};

export const PRESETS: readonly PresetDefinition[] = [UE_DEFERRED_PRESET, UE_PYTHON_PRESET];

export function resolvePreset(name: string): PresetDefinition {
  const found = PRESETS.find((p) => p.name === name);
  if (!found) {
    throw new Error(
      `unknown ue preset "${name}"; expected one of: ${PRESETS.map((p) => p.name).join(', ')}`,
    );
  }
  return found;
}
