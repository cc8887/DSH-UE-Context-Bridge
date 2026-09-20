// Drive a real editor crash from a Python exec command.
//
// Why not -ExecCmds=CRASH:
//   UEngine::TickDeferredCommands (UnrealEngine.cpp:2802) routes -ExecCmds to
//   LocalPlayer->Exec when GetDebugLocalPlayer() returns non-null, and only
//   falls back to UEngine::Exec otherwise. GetDebugLocalPlayer (14222) returns
//   a player whenever any world has a game instance with a first player, which
//   holds in the editor even for UnrealEditor-Cmd. So CRASH/GPF/CHECK never
//   reach UEngine::Exec (11222) and are swallowed. Verified empirically: the
//   run logged "Cmd: CRASH" but produced no crash directory and no Fatal.
//
// Why Python works:
//   The Python plugin registers its own exec handler, so "py <expr>" is
//   resolved before the LocalPlayer/Engine fallback question arises. Calling
//   a deliberately fatal engine assertion from Python goes through the real
//   crash path: crash dir, CrashContext.runtime-xml, minidump.
//
// This measures when artifacts appear relative to process exit, to test the
// claim (WindowsPlatformCrashContext.cpp:1001-1045) that they land first.

// Engine and project are discovered, never hard-coded, via scripts/lib/
// ue-discovery.mjs — the shared implementation used by every script here.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveUePaths } from './lib/ue-discovery.mjs';

const env = resolveUePaths({ require: 'editor' });
if (!env.ok) {
  console.log(`SKIP: ${env.reason}`);
  process.exit(0);
}
const {
  engineRoot: ENGINE_ROOT,
  projectRoot: PROJECT_ROOT,
  projectName: PROJECT_NAME,
  uproject: PROJECT,
  editor: EDITOR,
  crashes: CRASHES,
} = env;

function newestCrashDir() {
  if (!existsSync(CRASHES)) return undefined;
  const dirs = readdirSync(CRASHES)
    .map((n) => ({ n, full: join(CRASHES, n) }))
    .filter((e) => { try { return statSync(e.full).isDirectory(); } catch { return false; } })
    .sort((a, b) => statSync(b.full).mtimeMs - statSync(a.full).mtimeMs);
  return dirs[0]?.full;
}

if (!existsSync(EDITOR)) { console.log(`SKIP: no editor at ${EDITOR}`); process.exit(0); }
if (!existsSync(PROJECT)) { console.log(`SKIP: no project at ${PROJECT}`); process.exit(0); }

// A .py file avoids all command-line quoting problems: -ExecCmds="py <path>"
// is a single token, and the file can hold arbitrary statements.
const scriptDir = mkdtempSync(join(tmpdir(), 'ue-crash-'));
const scriptPath = join(scriptDir, 'provoke_crash.py').replace(/\\/g, '/');
// Why ctypes dereference rather than a Python exception:
//   Python's own errors are caught by the plugin and logged as
//   "LogPython: Error", never reaching the engine's crash handler. To reach
//   the real crash path (crash dir + CrashContext.runtime-xml + minidump) the
//   fault must happen in native code. Writing through a null pointer via
//   ctypes raises STATUS_ACCESS_VIOLATION, which the engine's SEH handler
//   treats exactly like any other crash.
writeFileSync(
  scriptPath,
  [
    'import unreal',
    'import ctypes',
    'import os',
    'unreal.log("PROVOKE_CRASH_MARKER: requesting native crash")',
    '# ctypes guards null *writes* with ValueError, so read from an unmapped',
    '# address instead: ctypes.string_at(1) performs a real native read that',
    '# the OS rejects with STATUS_ACCESS_VIOLATION, which reaches the engine\'s',
    '# SEH handler rather than Python\'s exception machinery.',
    'try:',
    '    ctypes.string_at(1, 16)',
    'except Exception as e:',
    '    unreal.log("PROVOKE_CRASH_MARKER: string_at raised " + str(e))',
    '# Definitive: abort() raises SIGABRT natively, outside Python\'s control.',
    'unreal.log("PROVOKE_CRASH_MARKER: falling back to os.abort")',
    'os.abort()',
    '',
  ].join('\n'),
  'utf8',
);
console.log(`provocation script: ${scriptPath}`);

const baseline = newestCrashDir();
console.log(`baseline crash dir: ${baseline ?? '(none)'}`);

const args = [
  PROJECT,
  `-ExecCmds=py ${scriptPath}`,
  '-unattended',
  '-nullrhi',
  '-NoSound',
  '-nosplash',
  '-NoLiveCoding',
  // Without a compiled CrashReportClient the engine can block waiting for a
  // response that will never come; this keeps the run bounded.
  '-FORCELOGFLUSH',
];
console.log(`launching: ${EDITOR}`);
const t0 = Date.now();
const child = spawn(EDITOR, args, { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

let firstArtifactAt = null;
const tail = [];
const decode = (b) => {
  try { return new TextDecoder('gbk').decode(b); } catch { return b.toString('utf8'); }
};
const pump = (b) => {
  const text = decode(b);
  for (const line of text.split(/\r?\n/)) if (line.trim()) tail.push(line);
  if (tail.length > 500) tail.splice(0, tail.length - 500);
};
child.stdout?.on('data', pump);
child.stderr?.on('data', pump);

const poll = setInterval(() => {
  const dir = newestCrashDir();
  if (!dir || dir === baseline) return;
  let entries = [];
  try { entries = readdirSync(dir); } catch { return; }
  if (entries.length === 0) return;
  let total = 0;
  for (const e of entries) {
    try { total += statSync(join(dir, e)).size; } catch { /* transient */ }
  }
  if (total > 0 && firstArtifactAt === null) firstArtifactAt = Date.now();
}, 50);

let done = false;
child.on('exit', (code, signal) => {
  if (done) return;
  done = true;
  clearInterval(poll);
  const exitAt = Date.now();
  const dir = newestCrashDir();
  const fresh = dir && dir !== baseline ? dir : undefined;

  const results = [];
  const check = (name, pass, detail) => {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  console.log(`\n--- crash verification (${((exitAt - t0) / 1000).toFixed(1)}s) ---`);
  check('process exited', code !== null || signal !== null, `code=${code} signal=${signal}`);
  check('new crash dir created', !!fresh, fresh ? fresh.split(/[/\\]/).slice(-2).join('/') : 'none');

  if (firstArtifactAt !== null) {
    const lead = exitAt - firstArtifactAt;
    console.log(`\nartifacts visible ${lead}ms before exit (poll 50ms)`);
    check('artifacts landed before exit', lead > 0, `${lead}ms lead`);
  } else {
    check('artifacts landed before exit', false, 'not observed before exit');
  }

  if (fresh) {
    let entries = [];
    try { entries = readdirSync(fresh); } catch { /* ignore */ }
    console.log(`\ncontents: ${entries.join(', ') || '(empty)'}`);
    const xml = join(fresh, 'CrashContext.runtime-xml');
    if (existsSync(xml)) {
      // The engine writes this file as UTF-16LE with a BOM (verified: first
      // bytes FF FE). Reading it as UTF-8 yields only replacement characters,
      // so every field would silently come back undefined.
      const raw = readFileSync(xml);
      const text =
        raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe
          ? new TextDecoder('utf-16le').decode(raw.subarray(2))
          : raw.toString('utf8');
      // Non-greedy: CrashReporterMessage appears more than once, and a greedy
      // match would swallow the fields between the first and last occurrence.
      const field = (k) =>
        new RegExp(`<${k}>([\\s\\S]*?)</${k}>`).exec(text)?.[1]?.trim();
      const type = field('CrashType');
      const guid = field('CrashGUID');
      const msg = field('ErrorMessage') ?? '';
      const exe = field('ExecutableName');
      console.log(`CrashType=${type} exe=${exe} guid=${guid}`);
      console.log(`ErrorMessage: ${msg.slice(0, 200)}`);
      // The crash is ours if the message names the abort we provoked rather
      // than some unrelated startup fault.
      const marker = /PROVOKE_CRASH_MARKER/.test(msg) || /Abort signal/i.test(msg);
      check('crash is ours', marker, marker ? msg.slice(0, 60) : 'marker absent');
      check('classified as Assert', type === 'Assert', `got ${type}`);
    }
  }

  const hit = tail.filter((l) => /fatal|assert|critical|PROVOKE|0x[0-9a-f]{8,}/i.test(l)).slice(-15);
  if (hit.length) {
    console.log('\n--- log tail ---');
    for (const l of hit) console.log(`  ${l.trim().slice(0, 160)}`);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
});

setTimeout(() => {
  if (done) return;
  console.log('TIMEOUT: no exit within 300s; killing');
  clearInterval(poll);
  child.kill('SIGKILL');
  const dir = newestCrashDir();
  console.log(`crash dir after timeout: ${dir && dir !== baseline ? dir : '(none new)'}`);
  process.exit(2);
}, 300_000);
