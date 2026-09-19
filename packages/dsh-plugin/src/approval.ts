/**
 * Approval policy (plan section 9.1).
 *
 * The classification comes from adapter rules or manual review, never from the
 * tool's name, never from the model's self-report, and never from an
 * unverified MCP annotation.
 */

import type { EffectClass, PythonExecuteRequest } from '@ue-bridge/contracts/model-tools';

export type ApprovalDecision = 'allow' | 'ask' | 'deny';

export interface ApprovalTarget {
  code: string;
  description: string;
  projectId: string;
  editorEpoch: string;
  adapterVersion: string;
}

/**
 * Python is always reviewed in v0.1: imports, loops and arbitrary `unreal.*`
 * calls all count. There is deliberately no `read_only` flag that pretends to
 * constrain Python permissions.
 */
export function classifyPythonExecution(_req: PythonExecuteRequest): ApprovalDecision {
  return 'ask';
}

export function classifyStructuredCall(effect: EffectClass): ApprovalDecision {
  switch (effect) {
    case 'verified_read':
      return 'allow';
    case 'write':
    case 'privileged':
    case 'unknown':
      return 'ask';
    default:
      return 'ask';
  }
}

/**
 * Invariant 7 (plan section 5.2): with no approval channel, a privileged
 * operation is refused rather than implicitly permitted.
 */
export function resolveDecision(
  base: ApprovalDecision,
  approvalChannelAvailable: boolean,
): ApprovalDecision {
  if (base === 'ask' && !approvalChannelAvailable) return 'deny';
  return base;
}

/**
 * An approval is bound to the exact code/argument digest, project, editor epoch
 * and adapter version. Any change invalidates it; an approval is never
 * reinterpreted as authorization for a different operation.
 */
export function approvalDigest(target: ApprovalTarget): string {
  const payload = JSON.stringify({
    code: target.code,
    description: target.description,
    projectId: target.projectId,
    editorEpoch: target.editorEpoch,
    adapterVersion: target.adapterVersion,
  });
  return `sha256:${simpleDigest(payload)}`;
}

/** FNV-1a. Sufficient for change detection; not a security primitive. */
export function simpleDigest(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
