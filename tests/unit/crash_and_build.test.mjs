/**
 * Crash and build-error capture, as a unit test.
 *
 * Complements scripts/verify_crash_and_build.mts, which needs a TS
 * transform flag; this runs under plain `npm test`.
 *
 * Both paths are driven with real child processes because the value is in the
 * reporting, not only the parsing: a build failure is useful once UBT's text
 * has become file/line/code entries, and a crash is useful once the exit and
 * log tail have become a report.
 *
 * No Unreal install is required. build() and start() launch whatever sits at
 * Engine/Build/BatchFiles/Build.bat and Engine/Binaries/<platform>/UnrealEditor,
 * so those are stand-ins. All paths come from os.tmpdir() â€?nothing here is
 * machine-specific.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { EditorSession } from '../../packages/dsh-plugin/src/editor-lifecycle.ts';

/** Temp roots created by this file; removed in after(). */
const temps = [];
function tempDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/**
 * A structurally valid engine root whose build output and exit code we control.
 *
 * Build.bat is a real batch file, because build() runs it through `cmd /c` and
 * cmd can only execute an actual batch file. Its text comes from `type`-ing a
 * prewritten file, which avoids every cmd escaping problem with the `(`, `^`
 * and `%` that UBT diagnostic lines contain.
 */
function fakeEngine(opts = {}) {
  const root = tempDir('dsh-fake-engine-');
  mkdirSync(join(root, 'Engine', 'Binaries', 'Win64'), { recursive: true });
  const batDir = join(root, 'Engine', 'Build', 'BatchFiles');
  mkdirSync(batDir, { recursive: true });
  writeFileSync(join(batDir, 'output.txt'), opts.buildOutput ?? '', 'utf8');
  writeFileSync(
    join(batDir, 'Build.bat'),
    ['@echo off', 'type "%~dp0output.txt"', `exit /b ${opts.buildExitCode ?? 0}`].join('\r\n'),
    'utf8',
  );
  return root;
}

/**
 * An editor "executable" dsh will really spawn: a copy of node.exe.
 *
 * start() passes the .uproject as its first argument, and node runs whatever
 * path it is given as a script â€?so the .uproject is the crash driver.
 */
function fakeEditor(engineRoot) {
  const dir = join(engineRoot, 'Engine', 'Binaries', 'Win64');
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, process.platform === 'win32' ? 'UnrealEditor.exe' : 'UnrealEditor');
  copyFileSync(process.execPath, exe);
  return exe;
}

function fakeProject(name, editorScript) {
  const root = tempDir('dsh-fake-project-');
  mkdirSync(join(root, 'Source'), { recursive: true });
  mkdirSync(join(root, 'Config'), { recursive: true });
  const uproject = join(root, `${name}.uproject`);
  writeFileSync(uproject, editorScript ?? JSON.stringify({ EngineAssociation: '' }), 'utf8');
  return { root, uproject };
}

function sessionFor(engineRoot, projectRoot, name) {
  const s = new EditorSession({ projectRoot, projectName: name, engineRoot });
  return s;
}

/** Wait for the session to leave `starting`, i.e. for the child to die. */
async function waitForExit(session, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.phase !== 'starting') return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('a build failure becomes structured file/line/code entries', async () => {
  const engine = fakeEngine({
    buildOutput: [
      'Building 2 actions with 4 processes...',
      `${join('proj', 'Source', 'Foo.cpp')}(10,2): error C3861: 'Bar': identifier not found`,
      `${join('proj', 'Source', 'Baz.h')}(3): warning C4996: 'x': was declared deprecated`,
    ].join('\n'),
    buildExitCode: 1,
  });
  const project = fakeProject('BuildFail');
  const session = sessionFor(engine, project.root, 'BuildFail');

  const result = await session.build({ force: true });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'C3861');
  assert.equal(result.errors[0].line, 10);
  assert.equal(result.errors[0].column, 2);
  assert.match(result.errors[0].file, /Foo\.cpp$/);
  assert.match(result.errors[0].message, /identifier not found/);
  // Warnings are kept but must not be counted as errors.
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].severity, 'warning');
  // A failure must never be cached as "nothing to do".
  assert.equal(result.upToDate, false);
  assert.equal(session.phase, 'stopped');
  session.dispose();
});

test('a non-zero exit with no parsable line still reports an error', async () => {
  const engine = fakeEngine({
    buildOutput: 'Unhandled exception: Unable to find target UnrealEditor',
    buildExitCode: 2,
  });
  const project = fakeProject('Unparsed');
  const session = sessionFor(engine, project.root, 'Unparsed');

  const result = await session.build({ force: true });

  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'UBT_EXIT_2');
  assert.match(result.errors[0].message, /Unable to find target/);
  session.dispose();
});

test('a clean build reports up to date from UBT, not by inference', async () => {
  const engine = fakeEngine({ buildOutput: 'Target is up to date', buildExitCode: 0 });
  const project = fakeProject('Clean');
  const session = sessionFor(engine, project.root, 'Clean');

  const result = await session.build({ force: true });

  assert.equal(result.ok, true);
  assert.equal(result.upToDate, true);
  assert.equal(result.source, 'ubt');
  assert.deepEqual(result.errors, []);
  session.dispose();
});

test('a crashed editor yields a report with exit code, crash dir and callstack', async () => {
  const engine = fakeEngine();
  fakeEditor(engine);
  // The .uproject is the script the fake editor runs, so it controls both the
  // streamed text and the exit code.
  const project = fakeProject(
    'Crasher',
    [
      `process.stdout.write(${JSON.stringify(
        [
          'Assertion failed: InExpression [File:AssertionMacros.cpp] [Line: 42]',
          '0x00007ffba1b2c3d4 UnrealEditor-Core.dll!FDebug::AssertFailed()',
        ].join('\n'),
      )});`,
      'process.exit(3);',
    ].join('\n'),
  );

  const logsDir = join(project.root, 'Saved', 'Logs');
  const crashDir = join(project.root, 'Saved', 'Crashes', 'crash-guid-1');
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(crashDir, { recursive: true });
  const logPath = join(logsDir, 'Crasher.log');
  writeFileSync(logPath, '0x00007ffba1b2c999 UnrealEditor-Engine.dll!UEditorEngine::Tick()', 'utf8');

  const session = sessionFor(engine, project.root, 'Crasher');
  const crashes = [];
  session.on('crash', (r) => crashes.push(r));

  await session.start();
  await waitForExit(session);

  const report = session.snapshot().lastCrash;
  assert.ok(report, 'no crash report was produced');
  assert.equal(session.phase, 'crashed');
  assert.equal(crashes.length, 1);
  assert.equal(report.exitCode, 3);
  assert.equal(report.crashDir, crashDir);
  assert.ok(existsSync(crashDir));
  assert.equal(report.logPath, logPath);
  const text = report.summary.join('\n');
  assert.match(text, /[Aa]ssertion failed/);
  assert.match(text, /0x[0-9a-f]{8,}/);
  // Bounded, so a huge log cannot flood the model's context.
  assert.ok(report.summary.length <= 40);
  session.dispose();
});

test('a clean editor exit is not reported as a crash', async () => {
  const engine = fakeEngine();
  fakeEditor(engine);
  const project = fakeProject(
    'CleanExit',
    'process.stdout.write("LogInit: Display: Engine is initialized");process.exit(0);',
  );

  const session = sessionFor(engine, project.root, 'CleanExit');
  const crashes = [];
  session.on('crash', (r) => crashes.push(r));

  await session.start();
  await waitForExit(session);

  assert.equal(session.phase, 'stopped');
  assert.equal(crashes.length, 0);
  assert.equal(session.snapshot().lastCrash, undefined);
  session.dispose();
});
