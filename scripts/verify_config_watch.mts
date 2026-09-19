/**
 * Verify the config watcher notices edits, including the write-then-rename
 * save pattern that silently breaks a watcher attached to a single file.
 */

import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditorRegistry } from '../packages/dsh-plugin/src/editor-registry.ts';
import { ConfigWatcher } from '../packages/dsh-plugin/src/config-watch.ts';

const root = mkdtempSync(join(tmpdir(), 'dsh-cfg-'));
mkdirSync(join(root, 'Config'));
const ini = join(root, 'Config', 'DefaultEngine.ini');

const registry = new EditorRegistry({ portRangeStart: 6800, portRangeEnd: 6810 });
const changes = [];
const watcher = new ConfigWatcher(registry, {
  pollIntervalMs: 500,
  onChange: (c) => changes.push(c),
});

const instance = await watcher.track(root, 'ProbeProject');
const port = instance.endpoint.port;
console.log(`port: ${port}, initial: ${instance.provisioned}`);
if (instance.provisioned !== 'unprovisioned') {
  console.log('FAIL: should start unprovisioned');
  process.exit(1);
}

// Direct write that matches the assigned endpoint.
writeFileSync(
  ini,
  `[/Script/PythonScriptPlugin.PythonScriptPluginSettings]\nbRemoteExecution=True\nRemoteExecutionMulticastGroupEndpoint=239.0.0.1:${port}\n`,
);
await new Promise((r) => setTimeout(r, 1200));
console.log(`after direct write: ${watcher.refresh(root)?.provisioned}`);
if (watcher.refresh(root)?.provisioned !== 'config-file') {
  console.log('FAIL: direct write not detected');
  process.exit(1);
}

// Atomic replace that breaks the config (wrong port).
const tmp = ini + '.tmp';
writeFileSync(tmp, `[/Script/PythonScriptPlugin.PythonScriptPluginSettings]\nbRemoteExecution=False\n`);
renameSync(tmp, ini);
await new Promise((r) => setTimeout(r, 1500));
const after = watcher.refresh(root)?.provisioned;
console.log(`after atomic replace: ${after}`);
if (after !== 'unprovisioned') {
  console.log('FAIL: atomic replace not detected');
  process.exit(1);
}

console.log(`change events: ${changes.length}`);
for (const c of changes) console.log(`  ${c.previous} -> ${c.current} (${c.kind})`);
if (changes.length === 0) {
  console.log('FAIL: no change callbacks fired');
  process.exit(1);
}

watcher.close();
rmSync(root, { recursive: true, force: true });
console.log('DONE');
