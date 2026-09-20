/**
 * Does caching UBT's verdict stay correct?
 *
 * The risk is not slowness, it is a stale "up to date" that hides a needed
 * compile. So this compares a cached read against what UBT actually says,
 * then confirms an edit invalidates the cache and forces a re-ask.
 *
 * Uses Lyra: it is already built, so UBT answers quickly and truthfully.
 *
 * Every real UBT invocation costs a full dependency-graph walk, so this keeps
 * them to the minimum that still proves the property:
 *
 *   - `force:true` only bypasses dsh's own cache. It does not make UBT
 *     recompile, and it is passed nowhere near Build.bat. Forcing the first
 *     build of a fresh session is a no-op, because a new EditorSession owns a
 *     new BuildFreshness and therefore starts with no cache to bypass.
 *   - The cache lives in memory on the session, so no second session can ever
 *     observe a first session's verdict. Running the cache checks on one
 *     session instead of two proves the same thing for one less UBT walk.
 *   - A run that answers "up to date" did no work, so it cannot have flipped
 *     the state it just reported. Only a run that did work can leave a
 *     verdict the next run disagrees with, so only that case re-asks.
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

// Baseline: what does UBT really say once the tree has settled?
const probe = makeSession();
await probe.prepare();
let truth = await probe.build();
if (!truth.upToDate) {
  // Run 1 did work, so its own verdict describes the tree before that work.
  truth = await probe.build();
}
console.log(`baseline (settled, asked UBT): upToDate=${truth.upToDate} source=${truth.source}`);
probe.dispose();

// Cached path, then edit invalidation, on one session.
const session = makeSession();
await session.prepare();
const c1 = await session.build();
const t2 = Date.now();
const c2 = await session.build();
const cachedMs = Date.now() - t2;
console.log(`after record: upToDate=${c1.upToDate} source=${c1.source}`);
console.log(`cached read:  upToDate=${c2.upToDate} source=${c2.source} ${cachedMs}ms`);

if (c2.source !== 'cache') {
  console.log('FAIL: second identical build did not come from cache');
  process.exit(1);
}
if (c2.upToDate !== truth.upToDate) {
  console.log(`FAIL: cache says ${c2.upToDate} but UBT says ${truth.upToDate}`);
  process.exit(1);
}
console.log(`  cache agrees with UBT, saved ~${Math.max(0, truth.durationMs - cachedMs)}ms`);

// The dangerous case: a source edit must invalidate the cache.
const beforeEdit = await session.build();
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
  const afterEdit = await session.build();
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
  session.dispose();
}

console.log('DONE');
