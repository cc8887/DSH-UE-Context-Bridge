// End-to-end: does the crash watcher notice before the process exits?
//
// This drives a real editor crash through EditorSession and checks the claim
// behind watchForCrashArtifacts(): that the engine writes Saved/Crashes before
// it exits, so a watcher reports a crash earlier than 'exit' does.
//
// The crash is provoked from Python because -ExecCmds=CRASH never reaches
// UEngine::Exec: TickDeferredCommands (UnrealEngine.cpp:2802) hands deferred
// commands to LocalPlayer->Exec whenever GetDebugLocalPlayer() returns non-null
// (14222), which holds in the editor even for UnrealEditor-Cmd. Python's exec
// handler is independent of that routing and os.abort() faults natively, so it
// reaches the engine's own crash handler.

// Engine and project are discovered, never hard-coded, via scripts/lib/
// ue-discovery.mjs — the shared implementation used by every script here.

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
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

if (!existsSync(EDITOR)) {
  console.log('SKIP: real engine or project not present');
  process.exit(0);
}

function newestCrashDir() {
  if (!existsSync(CRASHES)) return undefined;
  return readdirSync(CRASHES)
    .map((n) => join(CRASHES, n))
    .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

const dir = mkdtempSync(join(tmpdir(), 'ue-watch-'));
const script = join(dir, 'provoke.py').replace(/\\/g, '/');
writeFileSync(
  script,
  ['import unreal', 'import os', 'unreal.log("WATCH_TEST_MARKER: provoking")', 'os.abort()', ''].join('\n'),
  'utf8',
);

const baseline = newestCrashDir();
const t0 = Date.now();
const child = spawn(
  EDITOR,
  [PROJECT, `-ExecCmds=py ${script}`, '-unattended', '-nullrhi', '-nosplash', '-NoSound'],
  { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
);

const results = [];
const check = (name, pass, detail) => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// Mirror of the watcher: poll for a new crash dir while the process lives.
let earlyDir;
let earlyAt;
const poll = setInterval(() => {
  if (earlyDir) return;
  const latest = newestCrashDir();
  if (latest && latest !== baseline) {
    earlyDir = latest;
    earlyAt = Date.now();
  }
}, 100);

let done = false;
child.on('exit', (code) => {
  if (done) return;
  done = true;
  clearInterval(poll);
  const exitAt = Date.now();
  console.log(`\n--- crash watcher verification (${((exitAt - t0) / 1000).toFixed(1)}s) ---`);

  check('crash dir appeared', !!earlyDir, earlyDir ? earlyDir.split(/[/\\]/).pop() : 'none');
  check('process exited', code !== null, `code=${code}`);

  if (earlyDir && earlyAt) {
    const lead = exitAt - earlyAt;
    console.log(`\nartifacts seen ${lead}ms before exit`);
    check('watcher beats exit', lead > 0, `${lead}ms earlier`);
  } else {
    check('watcher beats exit', false, 'no artifact seen before exit');
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
});

setTimeout(() => {
  if (done) return;
  console.log('TIMEOUT after 300s');
  clearInterval(poll);
  child.kill('SIGKILL');
  process.exit(2);
}, 300_000);
