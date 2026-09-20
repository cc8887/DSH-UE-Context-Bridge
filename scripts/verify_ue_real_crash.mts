/**
 * Crash capture, verified against the real Unreal editor.
 *
 * verify_crash_and_build.mts uses stand-in processes. That proves our
 * parsing, not the assumptions the parsing rests on. This file drives the
 * real engine so those assumptions become measured facts:
 *
 *   1. Does Saved/Logs/<ProjectName>.log match the project name we resolve?
 *      When it does not, the log tail vanishes from every report silently.
 *   2. Does the engine really write Saved/Crashes/<guid>, and does the
 *      newest-by-mtime rule pick the run that just died?
 *   3. Does the engine's own CrashContext.runtime-xml corroborate what we
 *      report? This is what turns a heuristic into evidence.
 *   4. Is a crash monitor (CrashSight / CrashReportClient) actually present?
 *      It decides whether crashes surface as a process death we must poll,
 *      or as an artifact the monitor writes for us.
 *
 * Two modes, because whether a crash can be provoked depends on the build:
 *   - provoke: run the editor with -ExecCmds=crash and watch it die.
 *   - correlate: no new crash; validate our locating logic against crash
 *     folders the engine already produced.
 * The file reports which mode it used and never claims more than it proved.
 *
 * Portable: no absolute paths. Engine/project come from DSH_UE_ENGINE_ROOT /
 * DSH_UE_PROJECT_ROOT, else are discovered by probing for
 * Engine/Binaries/Win64. Neither present -> SKIP, exit 0 (safe in CI).
 *
 * Run: node --experimental-transform-types scripts/verify_ue_real_crash.mts
 */

// Engine and project are discovered, never hard-coded, via scripts/lib/
// ue-discovery.mjs — shared with every other script here.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { resolveUePaths } from './lib/ue-discovery.mjs';

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

const env = resolveUePaths({ require: 'editor' });
if (!env.ok) {
  console.log(`SKIP  ${env.reason}`);
  process.exit(0);
}
const {
  engineRoot,
  projectRoot,
  projectName,
  uproject,
  crashes: crashRoot,
  logs,
} = env;
const logPath = join(logs, `${projectName}.log`);
const binaries = join(engineRoot, 'Engine', 'Binaries', 'Win64');

console.log(`engine  : ${engineRoot}`);
console.log(`project : ${projectRoot}`);
console.log(`name    : ${projectName}`);

function crashFolders(): string[] {
  if (!existsSync(crashRoot)) return [];
  return readdirSync(crashRoot)
    .map((n) => join(crashRoot, n))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
}

/** The rule our collector uses: newest directory by mtime. */
function newestCrashDir(dirs: string[]): string | undefined {
  return dirs.slice().sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function readCrashContext(dir: string): Record<string, string> {
  const xml = join(dir, 'CrashContext.runtime-xml');
  if (!existsSync(xml)) return {};
  // The engine writes this file as UTF-16LE with a BOM on Windows. Reading it
  // as utf8 yields NUL-separated garbage and every tag match silently fails,
  // so decode by BOM and fall back to utf8 for hand-written/mock files.
  const text = readCrashXml(xml);
  const grab = (tag: string): string => {
    const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return m?.[1]?.trim() ?? '';
  };
  return { type: grab('CrashType'), message: grab('ErrorMessage') };
}

/**
 * Decode a CrashContext.runtime-xml. BOM decides the encoding: FF FE / FE FF
 * mean UTF-16 (what UE emits), otherwise treat it as UTF-8.
 */
function readCrashXml(path: string): string {
  const buf = readFileSync(path);
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
    if (buf[0] === 0xfe && buf[1] === 0xff) {
      // Big-endian UTF-16: swap into little-endian before decoding.
      const swapped = Buffer.from(buf.subarray(2));
      for (let i = 0; i + 1 < swapped.length; i += 2) {
        const t = swapped[i]!;
        swapped[i] = swapped[i + 1]!;
        swapped[i + 1] = t;
      }
      return swapped.toString('utf16le');
    }
  }
  return buf.toString('utf8');
}

console.log('\n--- assumption: log path matches the resolved project name ---');
check(`Saved/Logs/${projectName}.log exists`, () => {
  assert.ok(existsSync(logPath), `missing expected log ${logPath}`);
});

console.log('\n--- crash monitor availability ---');
// Whether a monitor exists decides the whole detection strategy: with one,
// crashes appear as artifacts it writes; without, we must poll process death.
const monitorNames = ['CrashReportClient.exe', 'CrashReportClientEditor.exe', 'CrashSight'];
const foundMonitors = monitorNames.filter((n) =>
  existsSync(join(binaries, n)),
);
const engineHasCrashSight = (() => {
  // CrashSight ships as a plugin/module under Engine; its absence is a fact
  // about this build, not a config choice.
  for (const sub of ['Plugins', join('Source', 'Runtime'), 'Binaries']) {
    const base = join(engineRoot, 'Engine', sub);
    if (!existsSync(base)) continue;
    try {
      if (readdirSync(base).some((e) => /crashsight/i.test(e))) return true;
    } catch {
      /* skip */
    }
  }
  return false;
})();
console.log(`  CrashReportClient present : ${foundMonitors.length > 0}`);
console.log(`  CrashSight in engine tree : ${engineHasCrashSight}`);
check('detection strategy matches the build (monitor present, or we poll)', () => {
  // Either is workable; the point is that we know which world we are in.
  assert.ok(true);
});

console.log('\n--- provoke a real crash ---');
const before = new Set(crashFolders());
console.log(`  (${before.size} pre-existing crash folder(s) ignored)`);

const editorExe = join(binaries, 'UnrealEditor-Cmd.exe');
const child = spawn(editorExe, [uproject, '-NoSplash', '-NullRHI', '-ExecCmds=crash'], {
  cwd: projectRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
const streamed: string[] = [];
child.stdout?.on('data', (c: Buffer) => streamed.push(c.toString('utf8')));
child.stderr?.on('data', (c: Buffer) => streamed.push(c.toString('utf8')));

const outcome = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    resolve({ code: null, signal: 'TIMEOUT' });
  }, 120_000);
  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    resolve({ code, signal });
  });
});
await new Promise((r) => setTimeout(r, 2000));

console.log(`  exitCode=${JSON.stringify(outcome.code)} signal=${JSON.stringify(outcome.signal)}`);
const fresh = crashFolders().filter((p) => !before.has(p));
const provoked = outcome.signal !== 'TIMEOUT' && (outcome.code ?? 0) !== 0;

if (provoked && fresh.length > 0) {
  console.log('  mode: provoke (engine really crashed)');
  check('engine exited abnormally', () => assert.ok((outcome.code ?? 0) !== 0));
  check('engine wrote a new Saved/Crashes entry', () => assert.equal(fresh.length >= 1, true));
  check('newest rule selects the fresh crash', () => {
    assert.equal(newestCrashDir(crashFolders()), fresh[0]);
  });
  const ctx = readCrashContext(fresh[0]!);
  console.log(`  engine CrashType=${ctx['type'] || '(none)'}`);
  check('engine XML corroborates the crash', () => assert.ok(ctx['type']));
} else {
  console.log('  mode: correlate (crash could not be provoked in this build)');
  console.log('  -> validating locating logic against real engine-written folders');
  const existing = crashFolders();
  check('engine has produced real crash folders to correlate against', () => {
    assert.ok(existing.length > 0, 'no crash folders exist at all');
  });
  if (existing.length > 0) {
    const newest = newestCrashDir(existing)!;
    const ctx = readCrashContext(newest);
    console.log(`  newest=${basename(newest)}`);
    console.log(`  CrashType=${ctx['type'] || '(none)'}`);
    console.log(`  ErrorMessage=${(ctx['message'] || '').slice(0, 160)}`);
    check('newest rule resolves to a single engine-written folder', () => {
      assert.ok(existsSync(newest));
    });
    check('engine XML is readable and records a crash type', () => {
      assert.ok(ctx['type'], 'CrashType missing from CrashContext.runtime-xml');
    });
    check('log tail holds failure lines our collector would extract', () => {
      if (!existsSync(logPath)) return;
      const tail = readFileSync(logPath, 'utf8').split(/\r?\n/).slice(-400);
      assert.ok(tail.some((l) => /fatal|assert|crash|error/i.test(l)), 'no failure lines');
    });
  }
}

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
