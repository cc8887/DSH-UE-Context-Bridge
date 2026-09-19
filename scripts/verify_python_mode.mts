/**
 * Verify python mode end to end against the live editor, using the endpoint
 * the dsh registry assigns for this project (not the stock 6766).
 *
 * Covers success, exception, and editor survival.
 */

import { EditorRegistry } from '../packages/dsh-plugin/src/editor-registry.ts';
import { PythonRemoteSession } from '../packages/dsh-plugin/src/remote-execution.ts';
import { PROJECT_ROOT, requireRealPath } from './paths.mts';

const projectRoot = requireRealPath('UE_BRIDGE_REPO or UE_PROJECT_ROOT', PROJECT_ROOT);
const registry = new EditorRegistry();
const instance = await registry.register(projectRoot);

console.log(`project: ${instance.projectName}`);
console.log(`endpoint: ${instance.endpoint.multicastGroup}:${instance.endpoint.port}`);
console.log(`provisioned: ${instance.provisioned}`);

const session = new PythonRemoteSession(instance.endpoint);

const editor = await session.discover();
console.log(`discovered: ${editor.projectName} (${editor.nodeId.slice(0, 8)})`);

console.log('--- success path ---');
const ok = await session.run('print("hello from dsh")\nprint(6 * 7)');
console.log(`  success: ${ok.success}`);
console.log(`  stdout: ${JSON.stringify(ok.output.map((o) => o.output).join(''))}`);
if (!ok.success) {
  console.log('FAIL: success path');
  process.exit(1);
}

console.log('--- exception path ---');
const bad = await session.run('raise RuntimeError("boom from dsh")');
console.log(`  success: ${bad.success}`);
console.log(`  stdout head: ${JSON.stringify(bad.stdout.slice(0, 120))}`);
if (bad.success) {
  console.log('FAIL: exception path should report failure');
  process.exit(1);
}
if (!bad.stdout.includes('RuntimeError: boom from dsh')) {
  console.log('FAIL: traceback not surfaced to caller');
  process.exit(1);
}

console.log('--- editor still alive ---');
const alive = await session.run('print("still alive")');
console.log(`  success: ${alive.success}`);
if (!alive.success) {
  console.log('FAIL: editor did not survive');
  process.exit(1);
}

await session.close();
console.log('DONE');
