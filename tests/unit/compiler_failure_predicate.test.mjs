/**
 * Behavioural test for the compiler-failure predicate.
 *
 * The source-shape assertions in editor_start_toolchain.test.mjs cannot catch
 * a predicate that is written correctly but reasons wrongly. This extracts and
 * evaluates the real function so the boundary is tested by behaviour: a genuine
 * compile error mentioning MSVC must not be reported as a toolchain failure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Lift the predicate out of the module and evaluate it. It has no imports, so
// this is safe and keeps it testable without exporting it purely for tests.
const src = readFileSync('packages/dsh-plugin/src/editor-lifecycle.ts', 'utf8');
const match = /function isCompilerSelectionFailure\(build: BuildResult\): boolean \{[\s\S]*?\n\}/.exec(src);
assert.ok(match, 'could not locate isCompilerSelectionFailure');

// Strip the single type annotation so the body runs as plain JS.
const body = match[0].replace(
  'function isCompilerSelectionFailure(build: BuildResult): boolean {',
  'function isCompilerSelectionFailure(build) {',
);
const isCompilerSelectionFailure = new Function(`${body}; return isCompilerSelectionFailure;`)();

function buildResult(rawTail, errors = []) {
  return {
    rawTail,
    errors,
    ok: false,
    exitCode: 1,
    durationMs: 0,
    warnings: [],
    upToDate: false,
    source: 'ubt',
  };
}

function sourceError(file = 'Foo.cpp') {
  return {
    file,
    line: 12,
    column: 3,
    severity: 'error',
    code: 'C3861',
    message: 'identifier not found',
  };
}

test('detects the enum-parse failure UBT emits for a missing Visual Studio', () => {
  const build = buildResult([
    "UnrealBuildTool : error : ArgumentException: Requested value 'VisualStudio2019' was not found.",
  ]);
  // No source file was ever compiled.
  assert.equal(isCompilerSelectionFailure(build), true);
});

test('detects a missing platform toolset', () => {
  const build = buildResult([
    'error MSB8020: The build tools for VisualStudio2026 (Platform Toolset) cannot be found.',
  ]);
  assert.equal(isCompilerSelectionFailure(build), true);
});

test('detects the failure even when UBT fills in the .uproject as the file', () => {
  // Observed against a real run: UBT-level exceptions carry
  // Lyra.uproject:0:0, which is not a source file. Treating it as one would
  // make the toolchain failure look like a compile error and hide the fix.
  const build = buildResult(
    ["Unhandled exception: ArgumentException: Requested value 'VisualStudio2019' was not found."],
    [
      {
        file: 'D:/UnrealEngine/Samples/Games/Lyra/Lyra.uproject',
        line: 0,
        column: 0,
        severity: 'error',
        code: 'UBT_EXIT_6',
        message: 'Requested value was not found',
      },
    ],
  );
  assert.equal(isCompilerSelectionFailure(build), true);
});

test('does NOT flag a real compile error that merely mentions MSVC', () => {
  // The compiler ran and rejected the code; a source file is named.
  const build = buildResult(
    ['SomeFile.cpp(12): error C3861: identifier not found'],
    [sourceError('SomeFile.cpp')],
  );
  assert.equal(isCompilerSelectionFailure(build), false);
});

test('does NOT flag an unrelated failure', () => {
  const build = buildResult(['error : Could not find NetFx48'], [sourceError('Other.cpp')]);
  assert.equal(isCompilerSelectionFailure(build), false);
});

test('ignores toolchain keywords when a real source file is implicated', () => {
  // The strongest case for the guard: the phrase appears, but a source file
  // also failed, so the toolchain clearly worked and this is a code error.
  const build = buildResult(
    ["error : Requested value 'VisualStudio2019' was not found", 'Foo.cpp(3): error C2143'],
    [sourceError('Foo.cpp')],
  );
  assert.equal(isCompilerSelectionFailure(build), false);
});
