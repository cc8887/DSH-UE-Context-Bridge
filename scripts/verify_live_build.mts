/**
 * Exercise the lifecycle against the real project and engine.
 *
 * Runs an actual UBT build (long) and reports what the model would receive.
 * Not part of the default verify set; run explicitly when the editor is idle.
 */

import { EditorSession } from '../packages/dsh-plugin/src/editor-lifecycle.ts';
import { PROJECT_ROOT, ENGINE_ROOT, requireRealPath } from './paths.mts';

const projectRoot = requireRealPath('UE_BRIDGE_REPO or UE_PROJECT_ROOT', PROJECT_ROOT);
const engineRoot = requireRealPath('UE_ENGINE_ROOT', ENGINE_ROOT);

const session = new EditorSession({
  projectRoot,
  projectName: 'DshUeBridgeProject',
  engineRoot,
});

console.log('--- prepare (endpoint + provisioning) ---');
const instance = await session.prepare();
console.log(`  endpoint ${instance.endpoint.multicastGroup}:${instance.endpoint.port}`);
console.log(`  provisioned ${instance.provisioned}`);
console.log(`  phase ${session.phase} alive ${session.alive}`);

console.log('--- real build ---');
const result = await session.build();
console.log(`  ok=${result.ok} exit=${result.exitCode} ${result.durationMs}ms`);
console.log(`  errors=${result.errors.length} warnings=${result.warnings.length}`);
for (const e of result.errors.slice(0, 8)) {
  console.log(`    ${e.severity} ${e.code} ${e.file}:${e.line}:${e.column} :: ${e.message}`);
}
if (result.warnings.length) {
  console.log(`  first warning: ${result.warnings[0]?.code} ${result.warnings[0]?.message}`);
}
if (!result.ok) {
  console.log('  --- raw tail (unclassified) ---');
  for (const l of result.rawTail.slice(-8)) console.log(`    | ${l}`);
}

console.log('--- snapshot ---');
const snap = session.snapshot();
console.log(`  phase=${snap.phase} project=${snap.projectName} provisioned=${snap.provisioned}`);

session.dispose();
console.log('DONE');
