import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CALL_ACTIONS,
  DEFERRED_TOOL_NAMES,
  PYTHON_TOOL_NAMES,
  retryPolicyForCode,
} from '../../packages/contracts/src/model-tools.ts';
import { BUDGETS, boundJson, utf8ByteLength } from '../../packages/contracts/src/results.ts';
import { searchCatalog, schemaRevisionOf, stableStringify } from '../../packages/gateway/src/catalog/catalog.ts';

/** @returns {any} */
function tool(id, toolName, toolset, description) {
  const inputSchema = { type: 'object', properties: { path: { type: 'string' } } };
  return {
    id,
    toolsetName: toolset,
    toolName,
    description,
    inputSchema,
    schemaRevision: schemaRevisionOf({ inputSchema, description, adapterVersion: '0.1.0' }),
    projectFingerprint: 'fp',
    engineBuild: 'build',
    effectClass: 'verified_read',
    effectEvidence: 'adapter_rule',
  };
}

const snapshot = {
  engineBuild: 'build',
  projectFingerprint: 'fp',
  editorEpoch: 'epoch-1',
  adapterVersion: '0.1.0',
  coverageComplete: false,
  builtAt: 'now',
  tools: [
    tool('AssetMetadata.GetMetadata', 'GetMetadata', 'AssetMetadata', 'Read asset metadata by path'),
    tool('AssetMetadata.SetMetadata', 'SetMetadata', 'AssetMetadata', 'Write asset metadata by path'),
    tool('EditorLevel.ListActors', 'ListActors', 'EditorLevel', 'List actors in the current level'),
  ],
};

// Lifecycle tools are shared by both modes: each mode needs a usable editor
// and a usable build environment. ue_env_check belongs here for the same
// reason - it is about the machine, not about which capability a mode exposes.
const LIFECYCLE_TOOLS = ['ue_editor_status', 'ue_editor_start', 'ue_editor_stop', 'ue_env_check'];

test('invariant 1: preset tool name sets are fixed and disjoint', () => {
  assert.deepEqual(DEFERRED_TOOL_NAMES, ['ue_find', 'ue_call', ...LIFECYCLE_TOOLS]);
  assert.deepEqual(PYTHON_TOOL_NAMES, ['ue_python_execute', ...LIFECYCLE_TOOLS]);
  // The capability entry points stay disjoint: a mode is defined by which one
  // it exposes. Lifecycle tools are shared because both modes need a usable
  // editor.
  const deferredOnly = DEFERRED_TOOL_NAMES.filter((n) => !LIFECYCLE_TOOLS.includes(n));
  const pythonOnly = PYTHON_TOOL_NAMES.filter((n) => !LIFECYCLE_TOOLS.includes(n));
  assert.equal(deferredOnly.filter((n) => pythonOnly.includes(n)).length, 0);
});

test('invariant 3: call action enum is a fixed small set', () => {
  assert.deepEqual([...CALL_ACTIONS], ['invoke', 'read_result', 'run_status']);
  assert.equal(CALL_ACTIONS.length, 3);
});

test('unknown writes never auto-retry', () => {
  assert.equal(retryPolicyForCode('REMOTE_OUTCOME_UNKNOWN'), 'needs_state_check');
  assert.equal(retryPolicyForCode('PROJECT_CHANGED'), 'needs_state_check');
  assert.equal(retryPolicyForCode('SCHEMA_STALE'), 'needs_rediscovery');
  assert.equal(retryPolicyForCode('EDITOR_UNAVAILABLE'), 'safe_to_retry');
});

test('schema revision is stable and order-independent', () => {
  const a = stableStringify({ b: 1, a: { d: 2, c: 3 } });
  const b = stableStringify({ a: { c: 3, d: 2 }, b: 1 });
  assert.equal(a, b);
  const r1 = schemaRevisionOf({ inputSchema: { x: 1 }, description: 'd', adapterVersion: '0.1.0' });
  const r2 = schemaRevisionOf({ inputSchema: { x: 1 }, description: 'd', adapterVersion: '0.1.0' });
  assert.equal(r1, r2);
  const r3 = schemaRevisionOf({ inputSchema: { x: 2 }, description: 'd', adapterVersion: '0.1.0' });
  assert.notEqual(r1, r3);
});

test('exact tool id outranks keyword matches', () => {
  const exact = searchCatalog(snapshot, undefined, ['EditorLevel.ListActors'], 5);
  assert.equal(exact.length, 1);
  assert.equal(exact[0].record.id, 'EditorLevel.ListActors');
  assert.equal(exact[0].score, 100);
});

test('keyword search respects limit and never returns the whole catalog as a fallback', () => {
  const hits = searchCatalog(snapshot, 'metadata', undefined, 5);
  assert.ok(hits.length > 0 && hits.length <= 5);
  assert.equal(searchCatalog(snapshot, 'zzz-no-match', undefined, 5).length, 0);
  assert.equal(searchCatalog(snapshot, undefined, undefined, 5).length, 0);
});

test('invariant 5: oversized values collapse and are flagged truncated', () => {
  const big = { items: Array.from({ length: 5000 }, (_, i) => `item-${i}`) };
  const bounded = boundJson(big, BUDGETS.RESULT_BYTES);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.actualBytes > BUDGETS.RESULT_BYTES);
  // The returned value itself must fit the budget, not just render shorter.
  assert.ok(utf8ByteLength(JSON.stringify(bounded.value)) <= BUDGETS.RESULT_BYTES);

  const small = boundJson({ a: 1 }, BUDGETS.RESULT_BYTES);
  assert.equal(small.truncated, false);
  assert.deepEqual(small.value, { a: 1 });
});

test('truncated results keep the total count instead of only failure samples', () => {
  const rows = Array.from({ length: 3000 }, (_, i) => ({
    index: i,
    assetPath: `/Game/Test/Asset_${i}`,
    ok: i < 5,
  }));
  const bounded = boundJson(rows, BUDGETS.RESULT_BYTES, rows);
  assert.equal(bounded.truncated, true);
  const summary = bounded.value.summary;
  assert.equal(summary.total, 3000);
  assert.ok(summary.returned < summary.total);
  assert.ok(utf8ByteLength(JSON.stringify(bounded.value)) <= BUDGETS.RESULT_BYTES);
});
