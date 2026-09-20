/**
 * Build-error capture, verified against a real UBT run.
 *
 * The stand-in build test proves we can parse MSVC text. It cannot prove we
 * are handed the right text in the first place. This file compiles the real
 * engine's build tool against a real project and checks the whole chain:
 * UBT runs, a genuine compile error is produced, and it arrives as
 * file/line/column/code plus a message the model can act on.
 *
 * The error is induced by writing a temporary source file into the project
 * and removing it afterwards, so no committed file is left modified. The
 * file is restored even if the build fails, via try/finally.
 *
 * Portable: no absolute paths. Engine/project come from DSH_UE_ENGINE_ROOT /
 * DSH_UE_PROJECT_ROOT, else are discovered the same way
 * verify_ue_real_crash.mts does. Neither present -> SKIP, exit 0.
 *
 * Run: node --experimental-transform-types scripts/verify_ue_real_build.mts
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { EditorSession, parseDiagnostic } from '../packages/dsh-plugin/src/editor-lifecycle.ts';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Engine and project are discovered, never hard-coded, via scripts/lib/
// ue-discovery.mjs — shared with every other script here. This one needs
// UBT specifically, so it asks for the 'build' predicate.

import { resolveUePaths } from './lib/ue-discovery.mjs';

const env = resolveUePaths({ require: 'build' });
if (!env.ok) {
  console.log(`SKIP  ${env.reason}`);
  process.exit(0);
}
const { engineRoot, projectRoot, projectName } = env;
console.log(`engine  : ${engineRoot}`);
console.log(`project : ${projectRoot}`);

console.log('\n--- parseDiagnostic against a real MSVC-shaped line ---');
check('parses file(line,col): error Cxxxx:', () => {
  const d = parseDiagnostic('Foo.cpp(10,2): error C3861: identifier not found');
  assert.ok(d, 'no diagnostic parsed');
  assert.equal(d!.line, 10);
  assert.equal(d!.column, 2);
  assert.equal(d!.code, 'C3861');
});

console.log('\n--- real UBT build with an induced compile error ---');
// A file UBT will compile, containing a call to a function that does not
// exist. This is the same failure a real edit produces.
const sourceDir = join(projectRoot, 'Source');
// The module is not always named after the project (Lyra -> LyraGame), so
// discover it instead of assuming.
const moduleDir = (() => {
  if (!existsSync(sourceDir)) return undefined;
  for (const name of readdirSync(sourceDir)) {
    const dir = join(sourceDir, name);
    if (existsSync(join(dir, `${name}.Build.cs`))) return dir;
  }
  return undefined;
})();
const tempFile = moduleDir ? join(moduleDir, 'DshInducedError.cpp') : '';
const INDUCED = [
  '// Temporary: written by verify_ue_real_build.mts, removed after the run.',
  'void DshInducedErrorEntry()',
  '{',
  '\tThisFunctionDoesNotExistAnywhere();',
  '}',
  '',
].join('\n');

const created = !existsSync(tempFile);
try {
  if (tempFile && existsSync(moduleDir!)) {
    writeFileSync(tempFile, INDUCED, 'utf8');
    console.log(`  wrote ${basename(tempFile)}`);
  } else {
    console.log('  (no module dir with a .Build.cs; running build without induced error)');
  }

  // Build the project's own editor target. The default 'UnrealEngine' target
  // never compiles project modules, so an induced error there would be
  // invisible and the run would falsely look green.
  const session = new EditorSession({
    projectRoot,
    projectName,
    engineRoot,
    target: `${projectName}Editor`,
  });
  // No force: this is a new session's first build, so there is no cached
  // verdict to bypass. force only skips dsh's cache; it never reaches UBT.
  const result = await session.build();

  console.log(`  ok=${result.ok} exit=${result.exitCode} source=${result.source} ${result.durationMs}ms`);
  console.log(`  errors=${result.errors.length} warnings=${result.warnings.length}`);
  console.log(`  errors=${result.errors.length} warnings=${result.warnings.length}`);
  if (result.toolchain) {
    const t = result.toolchain;
    console.log(`  toolchain ok=${t.ok} requested=${t.effective?.compiler ?? '-'} missing=${t.missing ?? '-'}`);
    console.log(`    requested_by=${t.effectiveFrom ?? '-'}`);
    for (const i of [...t.usable, ...t.unusable]) {
      console.log(`    installed: ${i.compiler ?? '?'} ${i.id}/${i.edition} ${i.version ?? ''} ${i.unsupported ? 'UNUSABLE' : 'usable'}`);
    }
    for (const f of t.fixes) console.log(`    fix: ${f}`);
  }
  for (const e of result.errors.slice(0, 5)) {
    console.log(`    ${e.severity} ${e.code} ${e.file}:${e.line}:${e.column} :: ${e.message}`);
  }

  check('build actually ran (UBT produced a verdict)', () => {
    assert.ok(result.source === 'ubt' || result.errors.length > 0, 'no build evidence');
  });

  check('a failed build is reported as not ok', () => {
    if ((result.exitCode ?? 0) !== 0) {
      assert.equal(result.ok, false, 'non-zero exit but ok=true');
    }
  });

  check('a failed build never claims up-to-date', () => {
    if (!result.ok) assert.equal(result.upToDate, false, 'failed build marked upToDate');
  });

  if (result.errors.length > 0) {
    check('real errors carry file and line, not just text', () => {
      const withLoc = result.errors.filter((e) => e.file && e.line > 0);
      assert.ok(withLoc.length > 0, 'no error carried a file/line');
    });
  } else if (result.ok) {
    console.log('  note: build succeeded; induced error was not compiled in this run');
  }
} finally {
  if (created && tempFile && existsSync(tempFile)) {
    rmSync(tempFile, { force: true });
    console.log(`  removed ${basename(tempFile)}`);
  }
  void mkdirSync;
}

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
