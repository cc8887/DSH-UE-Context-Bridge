import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyPythonExecution, classifyStructuredCall, resolveDecision, approvalDigest, simpleDigest } from '../../packages/dsh-plugin/src/approval.ts';
import { checkToolSurface, checkStaticSectionStable } from '../../packages/dsh-plugin/src/invariants.ts';
import { staticSectionFor } from '../../packages/dsh-plugin/src/section.ts';

test('invariant 7: no approval channel denies instead of permitting', () => {
  assert.equal(resolveDecision('ask', false), 'deny');
  assert.equal(resolveDecision('ask', true), 'ask');
  assert.equal(resolveDecision('allow', false), 'allow');
});

test('python is always reviewed; there is no read_only escape', () => {
  assert.equal(classifyPythonExecution({ code: 'import unreal', description: 'd' }), 'ask');
});

test('effect class drives structured-call policy; unknown is not trusted as read', () => {
  assert.equal(classifyStructuredCall('verified_read'), 'allow');
  assert.equal(classifyStructuredCall('write'), 'ask');
  assert.equal(classifyStructuredCall('privileged'), 'ask');
  assert.equal(classifyStructuredCall('unknown'), 'ask');
});

test('approval is bound to code, project, epoch and adapter version', () => {
  const base = { code: 'x=1', description: 'd', projectId: 'p', editorEpoch: 'e1', adapterVersion: '0.1.0' };
  const d1 = approvalDigest(base);
  assert.equal(d1, approvalDigest({ ...base }));
  assert.notEqual(d1, approvalDigest({ ...base, code: 'x=2' }));
  assert.notEqual(d1, approvalDigest({ ...base, editorEpoch: 'e2' }));
  assert.notEqual(d1, approvalDigest({ ...base, adapterVersion: '0.2.0' }));
  assert.equal(simpleDigest('abc'), simpleDigest('abc'));
});

const LIFECYCLE = ['ue_editor_status', 'ue_editor_start', 'ue_editor_stop', 'ue_env_check'];

test('invariant 1: leaked raw UE tools are detected', () => {
  const deferredFull = ['ue_find', 'ue_call', ...LIFECYCLE];
  const pythonFull = ['ue_python_execute', ...LIFECYCLE];
  assert.deepEqual(checkToolSurface('deferred', deferredFull), []);
  assert.deepEqual(checkToolSurface('python', pythonFull), []);
  // A capability entry point from the other mode is still a leak.
  assert.ok(
    checkToolSurface('deferred', [...deferredFull, 'ue_python_execute']).some((v) =>
      v.includes('unexpected UE tool'),
    ),
  );
  assert.ok(
    checkToolSurface('python', [...pythonFull, 'ue_find']).some((v) =>
      v.includes('unexpected UE tool'),
    ),
  );
  assert.ok(checkToolSurface('deferred', ['ue_find', ...LIFECYCLE]).some((v) => v.includes('missing')));
});

test('invariant 2: static sections carry no runtime state', () => {
  assert.deepEqual(checkStaticSectionStable('deferred'), []);
  assert.deepEqual(checkStaticSectionStable('python'), []);
});

test('static section text is deterministic across calls', () => {
  assert.equal(staticSectionFor('deferred'), staticSectionFor('deferred'));
  assert.notEqual(staticSectionFor('deferred'), staticSectionFor('python'));
});
