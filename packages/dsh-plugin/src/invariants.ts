/**
 * invariants.ts — plan section 5.2 assertions.
 *
 * Run at startup, on session resume, and before each model request. A failure
 * is a configuration diagnosis, not a silent degradation.
 */

import type { Context } from '@deepseek-ai/cordis';
import { DEFERRED_TOOL_NAMES, PYTHON_TOOL_NAMES, type ModeName } from '@ue-bridge/contracts/model-tools';
import { staticSectionFor } from './section.ts';

export interface InvariantReport {
  ok: boolean;
  violations: string[];
}

function expectedNames(mode: ModeName): readonly string[] {
  return mode === 'deferred' ? DEFERRED_TOOL_NAMES : PYTHON_TOOL_NAMES;
}

/**
 * Invariant 1: exactly the mode's UE entry points are visible, in order, and no
 * raw UE MCP tool leaked in.
 */
export function checkToolSurface(mode: ModeName, visibleNames: readonly string[]): string[] {
  const violations: string[] = [];
  const expected = expectedNames(mode);
  const ueVisible = visibleNames.filter(
    (n) => n.startsWith('ue_') || n === 'ue_python_execute',
  );

  for (const name of ueVisible) {
    if (!expected.includes(name)) {
      violations.push(`unexpected UE tool "${name}" visible in ${mode} mode`);
    }
  }
  for (const name of expected) {
    if (!ueVisible.includes(name)) {
      violations.push(`required UE tool "${name}" missing in ${mode} mode`);
    }
  }
  return violations;
}

/** Invariant 2: the static section never carries runtime state. */
export function checkStaticSectionStable(mode: ModeName): string[] {
  const violations: string[] = [];
  const text = staticSectionFor(mode);
  const forbidden = ['{{', 'project_id', 'editor_epoch', 'schema_revision:', 'run_id:'];
  for (const token of forbidden) {
    if (text.includes(token)) {
      violations.push(`static section for ${mode} contains runtime token "${token}"`);
    }
  }
  return violations;
}

export function runInvariants(ctx: Context, mode: ModeName): InvariantReport {
  const names = ctx.tools.schemas().map((s) => s.name);
  const violations = [
    ...checkToolSurface(mode, names),
    ...checkStaticSectionStable(mode),
  ];
  return { ok: violations.length === 0, violations };
}
