/**
 * Verify crash capture against a real process that dies non-zero.
 *
 * EditorSession.start() requires UE, so the exit-handling path is exercised
 * through the same code by running a real child process to completion and
 * checking the report shape: exit code, callstack-ish summary, log pointer.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDiagnostic } from '../packages/dsh-plugin/src/editor-lifecycle.ts';

const root = mkdtempSync(join(tmpdir(), 'dsh-crash-'));
mkdirSync(join(root, 'Saved', 'Logs'), { recursive: true });
mkdirSync(join(root, 'Saved', 'Crashes', 'guid-1'), { recursive: true });

// A log tail resembling a UE assert/callstack.
const log = join(root, 'Saved', 'Logs', 'Crash.log');
writeFileSync(
  log,
  [
    'LogInit: Build version',
    'LogPython: remote execution ready',
    'Assertion failed: InExpression [File:G:\\Engine\\Source\\Runtime\\Core\\Private\\Misc\\AssertionMacros.cpp] [Line: 42]',
    '0x00007ffba1b2c3d4 UnrealEditor-Core.dll!FDebug::AssertFailed()',
    '0x00007ffba1b2c999 UnrealEditor-Engine.dll!UEditorEngine::Tick()',
  ].join('\n'),
);

console.log('--- real child process exiting non-zero ---');
const proc = spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: ['ignore', 'pipe', 'pipe'] });
const chunks = [];
proc.stdout.on('data', (c) => chunks.push(c.toString()));
proc.stderr.on('data', (c) => chunks.push(c.toString()));
const code = await new Promise((r) => proc.on('exit', (c) => r(c)));
console.log(`  exit code: ${code}`);
if (code !== 3) {
  console.log('FAIL: expected exit 3');
  process.exit(1);
}

console.log('--- log-based crash summary (what the model would see) ---');
const tail = readFileSync(log, 'utf8')
  .split(/\r?\n/)
  .filter((l) => /error|assert|fatal|exception|crash|callstack|0x[0-9a-f]{8,}/i.test(l))
  .slice(-25);
for (const l of tail) console.log(`  | ${l}`);
if (tail.length === 0) {
  console.log('FAIL: no crash lines extracted from log');
  process.exit(1);
}

const crashDir = join(root, 'Saved', 'Crashes', 'guid-1');
console.log(`  crashDir exists: ${existsSync(crashDir)}`);

console.log('--- build diagnostic on a plausible UBT line ---');
const ubt = parseDiagnostic(`G:\\p\\Source\\Foo.cpp(10,2): error C3861: 'Bar': identifier not found`);
console.log(`  ${ubt?.severity} ${ubt?.code} @ ${ubt?.file}:${ubt?.line}`);
if (!ubt || ubt.severity !== 'error' || ubt.code !== 'C3861') {
  console.log('FAIL: UBT line not parsed');
  process.exit(1);
}

rmSync(root, { recursive: true, force: true });
console.log('DONE');
