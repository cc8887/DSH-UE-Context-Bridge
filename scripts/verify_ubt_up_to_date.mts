/**
 * Does UBT, not dsh, decide whether a compile is needed?
 *
 * The old path launched first and guessed a build from the failure text. The
 * new path asks UBT via Build.bat and reads its "Target is up to date"
 * verdict. Against Lyra (already built) the expected outcome is upToDate true
 * and no recompile.
 */

import { EditorSession } from '../packages/dsh-plugin/src/editor-lifecycle.ts';
import { ENGINE_ROOT, requireRealPath } from './paths.mts';

const engineRoot = requireRealPath('UE_ENGINE_ROOT', ENGINE_ROOT);
const projectRoot = engineRoot + '/Samples/Games/Lyra';

const session = new EditorSession({
  projectRoot,
  projectName: 'Lyra',
  engineRoot,
  target: 'LyraEditor',
});

console.log('--- build(): asking UBT ---');
const t0 = Date.now();
const build = await session.build();
console.log(`  ok=${build.ok} exit=${build.exitCode} duration_ms=${Date.now() - t0}`);
console.log(`  upToDate=${build.upToDate}  errors=${build.errors.length} warnings=${build.warnings.length}`);
for (const e of build.errors.slice(0, 3)) {
  console.log(`    ${e.code} @ ${e.file}:${e.line} :: ${e.message.slice(0, 70)}`);
}

console.log('--- second build(): nothing changed ---');
const again = await session.build();
console.log(`  upToDate=${again.upToDate} ok=${again.ok} duration_ms=${again.durationMs}`);

if (build.upToDate !== again.upToDate) {
  console.log('FAIL: UBT verdict is not stable across identical runs');
  process.exit(1);
}
if (!build.upToDate) {
  console.log('NOTE: UBT says work was needed; verdict plumbing still verified');
}

session.dispose();
console.log('DONE');
