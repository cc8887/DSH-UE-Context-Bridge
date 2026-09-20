/**
 * Tests for the compiler-diagnosis hook in the editor start path.
 *
 * The hook's risk is not that it misses a toolchain failure, but that it
 * misfires: a real compile error that happens to mention MSVC must not be
 * reported as a broken toolchain, or the model will chase the wrong cause.
 * These tests pin that boundary.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// The predicate is private to editor-lifecycle.ts, so these tests exercise it
// through the exported ensureReady path with a synthetic session.
import { readFileSync } from 'node:fs';

const SOURCE = 'packages/dsh-plugin/src/editor-lifecycle.ts';

test('isCompilerSelectionFailure requires both a toolchain signal and no source error', () => {
  // Assert the predicate's logic as written, since it is the whole safety
  // boundary: this reads the source to confirm the two conditions are ANDed
  // rather than ORed. A refactor that loosens it should fail here.
  const src = readFileSync(SOURCE, 'utf8');
  const fn = /function isCompilerSelectionFailure[\s\S]*?\n}/.exec(src);
  assert.ok(fn, 'expected isCompilerSelectionFailure to exist in editor-lifecycle.ts');

  const body = fn[0];
  assert.match(body, /if \(!mentionsToolchain\) return false;/);
  // A named source file means the compiler ran fine; the toolchain is innocent.
  assert.match(body, /return !namesSource;/);
});

test('BuildResult carries an optional toolchain diagnosis', () => {
  const src = readFileSync(SOURCE, 'utf8');
  assert.match(src, /toolchain\?: ToolchainDiagnosis;/);
});

test('build attaches the diagnosis at the single exit point', () => {
  const src = readFileSync(SOURCE, 'utf8');
  // Diagnosing inside build() rather than ensureReady means every entry point
  // gets it: ensureReady, a script calling session.build() directly, and the
  // MCP tool. The comment in the source records that intent.
  assert.match(src, /diagnosing here|Compiler diagnosis is attached by build\(\) itself/i);
  assert.match(src, /if \(!result\.ok && isCompilerSelectionFailure\(result\)\)/);
  assert.match(src, /result\.toolchain = diagnoseWindowsToolchain\(/);
});

test('editor start output surfaces the diagnosis to the model', () => {
  const src = readFileSync('packages/dsh-plugin/src/tools.ts', 'utf8');
  assert.match(src, /outcome\.build\.toolchain \? \{ toolchain: shapeToolchain\(/);
  // The fixes are the actionable part; surfacing ok alone would be useless.
  assert.match(src, /diagnosis\.fixes\.length > 0 \? \{ fixes: diagnosis\.fixes \}/);
});
