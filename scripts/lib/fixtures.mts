/**
 * Fixture builders: a fake engine and a fake project, in a temp directory.
 *
 * Why fake at all: build() and start() only touch two paths inside the engine
 * root — Engine/Build/BatchFiles/Build.bat and
 * Engine/Binaries/<platform>/UnrealEditor — and they launch them as real child
 * processes. Stand-ins whose output and exit code the test controls therefore
 * exercise the same spawn/parse/collect path a real UBT or editor would,
 * without Unreal being installed.
 *
 * The two stand-ins work differently, because the code launches them
 * differently:
 *
 *   Build.bat is a real batch file. build() runs it through `cmd /c`, and cmd
 *   can only execute an actual batch file — a copy of node.exe there just gets
 *   echoed back as binary. Its output comes from `type`-ing a prewritten text
 *   file, which sidesteps every cmd escaping problem with `(`, `^`, `%` and
 *   friends that a UBT diagnostic line is full of.
 *
 *   UnrealEditor is a copy of node.exe. start() spawns it directly with the
 *   .uproject path as its only argument, and node runs whatever path it is
 *   given as a script — so the project's .uproject doubles as the crash
 *   driver, controlling both the streamed text and the exit code.
 *
 * Everything comes from os.tmpdir(); no absolute path is hardcoded.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeEngine {
  root: string;
  buildBat: string;
}

/**
 * A minimal but structurally valid engine root.
 *
 * isValidRootDirectory requires Engine/Binaries and Engine/Build to exist;
 * build() additionally requires Build.bat. Creating all three keeps the
 * fixture consistent with what the code checks, so a failure means the test
 * is wrong rather than the fixture being rejected early.
 */
export function makeFakeEngine(opts: { buildOutput?: string; buildExitCode?: number } = {}): FakeEngine {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fake-engine-'));
  mkdirSync(join(root, 'Engine', 'Binaries', 'Win64'), { recursive: true });
  const batDir = join(root, 'Engine', 'Build', 'BatchFiles');
  mkdirSync(batDir, { recursive: true });
  writeFileSync(
    join(root, 'Engine', 'Build', 'Build.version'),
    JSON.stringify({ MajorVersion: 5, MinorVersion: 6 }),
    'utf8',
  );

  // `type` prints the text verbatim; `%~dp0` is this file's directory, so the
  // build can run from any cwd.
  writeFileSync(join(batDir, 'output.txt'), opts.buildOutput ?? '', 'utf8');
  const buildBat = join(batDir, 'Build.bat');
  writeFileSync(
    buildBat,
    ['@echo off', 'type "%~dp0output.txt"', `exit /b ${opts.buildExitCode ?? 0}`].join('\r\n'),
    'utf8',
  );
  return { root, buildBat };
}

/**
 * An editor "executable" dsh will really spawn.
 *
 * Returns the path start() will use. It is a copy of node.exe; start() passes
 * the .uproject as its first argument, which node runs as its script.
 */
export function makeFakeEditor(engine: FakeEngine): string {
  const platform = 'Win64';
  const exeName = process.platform === 'win32' ? 'UnrealEditor.exe' : 'UnrealEditor';
  const dir = join(engine.root, 'Engine', 'Binaries', platform);
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, exeName);
  copyFileSync(process.execPath, exe);
  return exe;
}

export interface FakeProject {
  root: string;
  name: string;
  uproject: string;
}

/**
 * A project directory containing one .uproject, as findUproject() expects.
 *
 * `editorScript` is for crash cases: the .uproject is what the fake editor
 * executes, so it must then be JavaScript that prints and exits, not JSON.
 */
export function makeFakeProject(name = 'FakeProject', editorScript?: string): FakeProject {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fake-project-'));
  mkdirSync(join(root, 'Source'), { recursive: true });
  mkdirSync(join(root, 'Config'), { recursive: true });
  const uproject = join(root, `${name}.uproject`);
  writeFileSync(uproject, editorScript ?? JSON.stringify({ EngineAssociation: '' }), 'utf8');
  return { root, name, uproject };
}

/** Crash artifacts the engine leaves behind: a log tail and a crash folder. */
export function seedCrashArtifacts(
  project: FakeProject,
  logTail: string[],
): { logPath: string; crashDir: string } {
  const logsDir = join(project.root, 'Saved', 'Logs');
  const crashDir = join(project.root, 'Saved', 'Crashes', 'crash-guid-1');
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(crashDir, { recursive: true });
  const logPath = join(logsDir, `${project.name}.log`);
  writeFileSync(logPath, logTail.join('\n'), 'utf8');
  writeFileSync(join(crashDir, 'CrashContext.runtime-xml'), '<crash/>', 'utf8');
  return { logPath, crashDir };
}

export function cleanup(...roots: string[]): void {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}
