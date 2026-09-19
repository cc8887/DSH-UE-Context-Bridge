/**
 * Does caching UBT's verdict stay correct?
 *
 * The risk is not slowness, it is a stale "up to date" that hides a needed
 * compile. So this compares a cached read against what UBT actually says,
 * then confirms an edit invalidates the cache and forces a re-ask.
 *
 * Uses Lyra: it is already built, so UBT answers quickly and truthfully.
 */

import { EditorSession } from '../packages/dsh-plugin/src/editor-lifecycle.ts';
import { ENGINE_ROOT, requireRealPath } from './paths.mts';

const engineRoot = requireRealPath('UE_ENGINE_ROOT', ENGINE_ROOT);
const projectRoot = engineRoot + '/Samples/Games/Lyra';

function makeSession(): EditorSession {
  return new EditorSession({
    projectRoot,
    projectName: 'Lyra',
    engineRoot,
    target: 'LyraEditor',
  });
}

// Baseline: what does UBT really say once the tree has settled? A single run
// can legitimately flip state by doing work, so ask until two agree.
const probe = makeSession();
await probe.prepare();
let truth = await probe.build({ force: true });
for (let i = 0; i < 3; i += 1) {
  const again = await probe.build({ force: true });
  if (again.upToDate === truth.upToDate) {
    truth = again;
    break;
  }
  truth = again;
}
console.log(`baseline (settled, asked UBT): upToDate=${truth.upToDate} source=${truth.source}`);
probe.dispose();

// Cached path: same question, should not re-run UBT.
const cached = makeSession();
await cached.prepare();
const t1 = Date.now();
const c1 = await cached.build({ force: true });
await cached.prepare();
const t2 = Date.now();
const c2 = await cached.build();
console.log(`after record: upToDate=${c1.upToDate} source=${c1.source}`);
console.log(`cached read:  upToDate=${c2.upToDate} source=${c2.source} ${Date.now() - t2}ms`);

if (c2.source !== 'cache') {
  console.log('FAIL: second identical build did not come from cache');
  process.exit(1);
}
if (c2.upToDate !== truth.upToDate) {
  console.log(`FAIL: cache says ${c2.upToDate} but UBT says ${truth.upToDate}`);
  process.exit(1);
}
console.log(`  cache agrees with UBT, saved ~${Math.max(0, truth.durationMs - (Date.now() - t2))}ms`);

// The dangerous case: a source edit must invalidate the cache.
const watcher = makeSession();
await watcher.prepare();
await watcher.build({ force: true });
const beforeEdit = await watcher.build();
console.log(`before edit: source=${beforeEdit.source}`);
if (beforeEdit.source !== 'cache') {
  console.log('FAIL: expected a cached read before the edit');
  process.exit(1);
}

const target = engineRoot + '/Samples/Games/Lyra/Source/LyraGame/LyraGameModule.cpp';
const original = await (await import('node:fs/promises')).readFile(target, 'utf8');
await (await import('node:fs/promises')).writeFile(target, `${original}\n// dsh freshness probe\n`);
try {
  // Give the watcher a moment; the mtime check is the backstop either way.
  await new Promise((r) => setTimeout(r, 700));
  const afterEdit = await watcher.build();
  console.log(`after edit:  source=${afterEdit.source} upToDate=${afterEdit.upToDate}`);
  if (afterEdit.source !== 'ubt') {
    console.log('FAIL: an edited source was served from cache');
    process.exit(1);
  }
  if (afterEdit.upToDate) {
    console.log('FAIL: UBT still reports up to date after a real .cpp edit');
    process.exit(1);
  }
  console.log('  edit correctly forced a re-ask, and UBT says work is needed');
} finally {
  await (await import('node:fs/promises')).writeFile(target, original);
  watcher.dispose();
}

console.log('DONE');
