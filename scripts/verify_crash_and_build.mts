/**
 * Does the plugin actually capture crash information and build errors?
 *
 * Both paths are driven end-to-end with real child processes, because the
 * value is in the parsing and reporting, not in the parsing alone: a build
 * "failure" is only useful once UBT's text has become file/line/code entries,
 * and a crash is only useful once the exit and the log tail have become a
 * report the model can act on.
 *
 * No Unreal install is required. build() and start() spawn whatever sits at
 * Engine/Build/BatchFiles/Build.bat and Engine/Binaries/<platform>/UnrealEditor,
 * so those two are stand-ins whose output and exit code this file controls.
 * All paths come from os.tmpdir() — nothing here is machine-specific.
 *
 * Run: node --experimental-strip-types scripts/verify_crash_and_build.mts
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EditorSession, parseDiagnostic } from '../packages/dsh-plugin/src/editor-lifecycle.ts';
import {
  makeFakeEngine,
  makeFakeEditor,
  makeFakeProject,
  seedCrashArtifacts,
  cleanup,
} from './lib/fixtures.mts';

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

async function section(title: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n--- ${title} ---`);
  await fn();
}

/** A UBT failure: real MSVC diagnostics plus the exit code UBT would give. */
const BUILD_OUTPUT = [
  'Building 2 actions with 4 processes...',
  // Relative so the sample is portable; parseDiagnostic only splits on the
  // trailing (line,col), so it does not care whether the path is rooted.
  `${join('proj', 'Source', 'Foo.cpp')}(10,2): error C3861: 'Bar': identifier not found`,
  `${join('proj', 'Source', 'Baz.h')}(3): warning C4996: 'x': was declared deprecated`,
  '  (compiling took 1.2s)',
].join('\n');

await section('build failure is parsed into structured errors', async () => {
  const engine = makeFakeEngine({ buildOutput: BUILD_OUTPUT, buildExitCode: 1 });
  const project = makeFakeProject('BuildFail');
  const session = new EditorSession({
    projectRoot: project.root,
    projectName: project.name,
    engineRoot: engine.root,
  });

  const result = await session.build({ force: true });
  console.log(`  ok=${result.ok} exit=${result.exitCode} source=${result.source}`);
  console.log(`  errors=${result.errors.length} warnings=${result.warnings.length}`);
  for (const e of result.errors) {
    console.log(`    ${e.severity} ${e.code} ${e.file}:${e.line}:${e.column} :: ${e.message}`);
  }

  check('a non-zero UBT exit is reported as a failure', () => {
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
  });
  check('the diagnostic is parsed into file/line/code/message', () => {
    assert.equal(result.errors.length, 1);
    const e = result.errors[0]!;
    assert.equal(e.code, 'C3861');
    assert.equal(e.line, 10);
    assert.equal(e.column, 2);
    assert.match(e.file, /Foo\.cpp$/);
    assert.match(e.message, /identifier not found/);
  });
  check('warnings are kept but do not fail the build', () => {
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]!.code, 'C4996');
    assert.equal(result.warnings[0]!.severity, 'warning');
  });
  check('a failed build is never cached as up to date', () => {
    assert.equal(result.upToDate, false);
  });
  check('raw tail is retained on failure to explain unparsed output', () => {
    assert.ok(result.rawTail.length > 0);
  });
  check('a failed build leaves the session stopped, not building', () => {
    assert.equal(session.phase, 'stopped');
  });

  session.dispose();
  cleanup(engine.root, project.root);
});

await section('a non-zero exit with no parsable line still reports an error', async () => {
  // UBT can fail before emitting any diagnostic (missing SDK, bad target).
  // The model must still get an error rather than an empty list.
  const engine = makeFakeEngine({
    buildOutput: 'Unhandled exception: Unable to find target UnrealEditor',
    buildExitCode: 2,
  });
  const project = makeFakeProject('Unparsed');
  const session = new EditorSession({
    projectRoot: project.root,
    projectName: project.name,
    engineRoot: engine.root,
  });

  const result = await session.build({ force: true });
  console.log(`  ok=${result.ok} errors=${result.errors.length} code=${result.errors[0]?.code}`);
  console.log(`  message=${result.errors[0]?.message}`);

  check('failure surfaces with a synthetic code rather than being dropped', () => {
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.code, 'UBT_EXIT_2');
  });
  check("UBT's own verdict text is carried in the message", () => {
    assert.match(result.errors[0]!.message, /Unable to find target/);
  });

  session.dispose();
  cleanup(engine.root, project.root);
});

await section('a successful build reports up to date from UBT, not by inference', async () => {
  const engine = makeFakeEngine({
    buildOutput: 'Target is up to date',
    buildExitCode: 0,
  });
  const project = makeFakeProject('Clean');
  const session = new EditorSession({
    projectRoot: project.root,
    projectName: project.name,
    engineRoot: engine.root,
  });

  const result = await session.build({ force: true });
  console.log(`  ok=${result.ok} upToDate=${result.upToDate} source=${result.source}`);

  check('success is not reported as a failure', () => {
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });
  check("UBT's own up-to-date line is the source of the verdict", () => {
    assert.equal(result.upToDate, true);
    assert.equal(result.source, 'ubt');
  });
  check('a successful build keeps no error tail', () => {
    assert.deepEqual(result.rawTail, []);
  });

  session.dispose();
  cleanup(engine.root, project.root);
});

await section('a crashed editor produces a report, not a silent exit', async () => {
  const engine = makeFakeEngine();
  // start() passes the .uproject as the editor's only argument, and the fake
  // editor is a copy of node.exe — so the .uproject is the script it runs.
  // That is what lets this case control both the streamed output and the code.
  const project = makeFakeProject(
    'Crasher',
    [
      `process.stdout.write(${JSON.stringify(
        [
          'LogInit: Display: Engine is initialized',
          'Assertion failed: InExpression [File:AssertionMacros.cpp] [Line: 42]',
          '0x00007ffba1b2c3d4 UnrealEditor-Core.dll!FDebug::AssertFailed()',
        ].join('\n'),
      )});`,
      'process.exit(3);',
    ].join('\n'),
  );
  makeFakeEditor(engine);
  const { logPath, crashDir } = seedCrashArtifacts(project, [
    'LogInit: Build version',
    'LogPython: remote execution ready',
    'Assertion failed: InExpression [File:AssertionMacros.cpp] [Line: 42]',
    '0x00007ffba1b2c999 UnrealEditor-Engine.dll!UEditorEngine::Tick()',
  ]);

  const session = new EditorSession({
    projectRoot: project.root,
    projectName: project.name,
    engineRoot: engine.root,
  });

  const crashes: unknown[] = [];
  const phases: string[] = [];
  session.on('crash', (r) => crashes.push(r));
  session.on('phase', (p) => phases.push(String(p)));

  await session.start();

  // The child dies almost immediately; wait for the exit handler to run.
  const report = await new Promise<{ exitCode: number | null; summary: string[]; crashDir?: string; logPath?: string }>(
    (resolve) => {
      const deadline = Date.now() + 15_000;
      const poll = () => {
        const snap = session.snapshot();
        if (snap.lastCrash || Date.now() > deadline) {
          resolve(
            snap.lastCrash ?? { exitCode: null, summary: [] },
          );
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    },
  );

  console.log(`  exitCode=${report.exitCode} phase=${session.phase}`);
  console.log(`  crashDir=${report.crashDir ? 'yes' : 'no'} logPath=${report.logPath ? 'yes' : 'no'}`);
  console.log(`  summary lines=${report.summary.length}`);
  for (const l of report.summary.slice(0, 4)) console.log(`    | ${String(l).slice(0, 90)}`);

  check('a non-zero exit moves the session to crashed', () => {
    assert.equal(session.phase, 'crashed');
    assert.ok(phases.includes('crashed'), `phases: ${phases.join(',')}`);
  });
  check('the crash event fired once', () => {
    assert.equal(crashes.length, 1);
  });
  check('the exit code is preserved', () => {
    assert.equal(report.exitCode, 3);
  });
  check('the newest crash directory is located', () => {
    assert.equal(report.crashDir, crashDir);
    assert.ok(existsSync(crashDir));
  });
  check('the log path is recorded', () => {
    assert.equal(report.logPath, logPath);
  });
  check('assertion and callstack lines are extracted into the summary', () => {
    assert.ok(report.summary.length > 0, 'summary is empty');
    const text = report.summary.join('\n');
    assert.match(text, /[Aa]ssertion failed/, 'no assertion line');
    assert.match(text, /0x[0-9a-f]{8,}/, 'no callstack frame');
  });
  check('the report is bounded, not the whole log', () => {
    assert.ok(report.summary.length <= 40, `summary too long: ${report.summary.length}`);
  });

  session.dispose();
  cleanup(engine.root, project.root);
});

await section('a clean exit is not reported as a crash', async () => {
  const engine = makeFakeEngine();
  const project = makeFakeProject(
    'CleanExit',
    `process.stdout.write("LogInit: Display: Engine is initialized");process.exit(0);`,
  );
  makeFakeEditor(engine);

  const session = new EditorSession({
    projectRoot: project.root,
    projectName: project.name,
    engineRoot: engine.root,
  });
  const crashes: unknown[] = [];
  session.on('crash', (r) => crashes.push(r));

  await session.start();
  await new Promise<void>((resolve) => {
    const deadline = Date.now() + 15_000;
    const poll = () => {
      if (session.phase === 'stopped' || Date.now() > deadline) return resolve();
      setTimeout(poll, 50);
    };
    poll();
  });

  console.log(`  phase=${session.phase} crashes=${crashes.length}`);
  check('exit code 0 ends stopped, not crashed', () => {
    assert.equal(session.phase, 'stopped');
    assert.equal(crashes.length, 0);
  });
  check('no crash report is attached', () => {
    assert.equal(session.snapshot().lastCrash, undefined);
  });

  session.dispose();
  cleanup(engine.root, project.root);
});

await section('diagnostic parser covers the shapes UBT and clang emit', () => {
  const cases: Array<[string, string | undefined, number | undefined]> = [
    [`${join('P', 'A.cpp')}(12,5): error C2065: 'Foo': undeclared identifier`, 'C2065', 12],
    [`${join('P', 'B.cpp')}(3): warning C4996: deprecated`, 'C4996', 3],
    ['/proj/S/C.cpp:44:12: error: use of undeclared', 'compiler', 44],
    ['some unrelated progress text', undefined, undefined],
  ];
  for (const [line, code, lineNo] of cases) {
    const d = parseDiagnostic(line);
    const got = `${d ? `${d.severity} ${d.code} @${d.line}` : '(ignored)'}`;
    console.log(`  ${got.padEnd(28)} <- ${line.slice(0, 60)}`);
    check(`parses as expected: ${line.slice(0, 40)}`, () => {
      if (code === undefined) {
        assert.equal(d, undefined);
      } else {
        assert.ok(d, 'expected a diagnostic');
        assert.equal(d.code, code);
        assert.equal(d.line, lineNo);
      }
    });
  }
});

console.log(`\n${failures === 0 ? 'DONE — all checks passed' : `DONE — ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
