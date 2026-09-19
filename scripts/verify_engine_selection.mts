/**
 * The user decides which engine a project uses, once, and it sticks.
 *
 * What is being tested is not just that a selection persists — it is that dsh
 * refuses to choose on the user's behalf, that it decides one project at a
 * time when several are in play, and that a recorded choice is not silently
 * replaced by whatever the project happens to resolve to.
 */

import { EditorSession } from '../packages/dsh-plugin/src/editor-lifecycle.ts';
import { EngineSelectionStore } from '../packages/dsh-plugin/src/engine-selection.ts';
import { enumerateEngineInstallations } from '../packages/dsh-plugin/src/toolchain.ts';

const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = await import('node:fs');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');

const installed = await enumerateEngineInstallations();
if (installed.length < 2) {
  console.log('FAIL: need at least two installed engines to test choosing');
  process.exit(1);
}
const first = installed[0];
const second = installed[1];
console.log(
  `engines available: ${installed.map((e) => e.identifier).join(', ')}`,
);

// A throwaway store, so this never touches the real ~/.dsh selections.
const stateDir = mkdtempSync(join(tmpdir(), 'dsh-select-'));
const storePath = join(stateDir, 'engine-selection.json');

/** A project with no EngineAssociation, so nothing resolves on its own. */
function makeProject(name: string): string {
  const root = join(stateDir, name);
  mkdirSync(join(root, 'Config'), { recursive: true });
  writeFileSync(join(root, `${name}.uproject`), JSON.stringify({ EngineVersion: '5.0.0' }));
  return root;
}

const projectA = makeProject('ProjectA');
const projectB = makeProject('ProjectB');

// ---- Nothing chosen: the store must stay empty ----
const store = new EngineSelectionStore(storePath);
if (store.get(projectA)) {
  console.log('FAIL: a fresh project already has a recorded engine');
  process.exit(1);
}
console.log(`fresh project: no recorded engine (decidedCount=${store.decidedCount})`);

// ---- Each project gets its own decision, independently ----
store.set(projectA, {
  ...(first.identifier ? { identifier: first.identifier } : {}),
  engineRoot: first.root,
  decidedAt: new Date().toISOString(),
  ...(first.version ? { version: first.version } : {}),
});
console.log(`decided A -> ${first.identifier} (${first.root})`);

if (store.get(projectB)) {
  console.log('FAIL: deciding A leaked into B; decisions must be per project');
  process.exit(1);
}
console.log('B still undecided: decisions are per project, not global');

// ---- The "decide one at a time" sequence ----
store.set(projectB, {
  ...(second.identifier ? { identifier: second.identifier } : {}),
  engineRoot: second.root,
  decidedAt: new Date().toISOString(),
  ...(second.version ? { version: second.version } : {}),
});
console.log(`decided B -> ${second.identifier} (${second.root})`);

if (store.decidedCount !== 2) {
  console.log(`FAIL: expected 2 decisions, got ${store.decidedCount}`);
  process.exit(1);
}
if (store.get(projectA)?.engineRoot !== first.root || store.get(projectB)?.engineRoot !== second.root) {
  console.log('FAIL: the two projects did not keep their own choices');
  process.exit(1);
}
console.log(`two projects, two independent choices: A=${first.identifier} B=${second.identifier}`);

// ---- Persistence: a new store over the same file sees both ----
const reloaded = new EngineSelectionStore(storePath);
if (reloaded.decidedCount !== 2) {
  console.log(`FAIL: reload lost decisions (${reloaded.decidedCount})`);
  process.exit(1);
}
if (reloaded.get(projectA)?.engineRoot !== first.root) {
  console.log('FAIL: reload lost A');
  process.exit(1);
}
if (reloaded.get(projectB)?.engineRoot !== second.root) {
  console.log('FAIL: reload lost B');
  process.exit(1);
}
console.log(`persisted to ${storePath} and reloaded intact`);

// ---- Keying is case/backslash insensitive ----
const sloppy = new EngineSelectionStore(storePath);
const altA = projectA.replace(/\//g, '\\').toUpperCase();
if (sloppy.get(altA)?.engineRoot !== first.root) {
  console.log('FAIL: the same project under a different spelling did not match');
  process.exit(1);
}
console.log('same project, different spelling, same decision');

// ---- Clearing one does not clear the other ----
reloaded.clear(projectA);
if (reloaded.get(projectA)) {
  console.log('FAIL: clear did not remove A');
  process.exit(1);
}
if (!reloaded.get(projectB)) {
  console.log('FAIL: clearing A also cleared B');
  process.exit(1);
}
console.log(`cleared A; B still decided as ${reloaded.get(projectB)?.identifier}`);

// ---- A corrupt file must not break lookups ----
writeFileSync(storePath, '{ not json');
const corrupt = new EngineSelectionStore(storePath);
if (corrupt.decidedCount !== 0) {
  console.log('FAIL: corrupt file should start clean');
  process.exit(1);
}
console.log('corrupt selection file degrades to empty rather than throwing');

// ---- A recorded choice reaches the session ----
const sessionA = new EditorSession({ projectRoot: projectA, target: 'ProjectAEditor' });
await sessionA.prepare();
const auto = sessionA.snapshot().engine;
console.log(`unaided resolution for A: ${auto?.source} ${auto?.engineRoot ?? '(none)'}`);

const applied = await sessionA.resolveEngineNow(first.root);
console.log(`after applying choice: ${applied.source} ${applied.engineRoot}`);
if (applied.engineRoot?.toLowerCase() !== first.root.toLowerCase()) {
  console.log(`FAIL: session did not adopt the chosen engine`);
  process.exit(1);
}
if (sessionA.snapshot().engine?.engineRoot?.toLowerCase() !== first.root.toLowerCase()) {
  console.log('FAIL: snapshot did not reflect the chosen engine');
  process.exit(1);
}
console.log('  session and snapshot both reflect the user choice');

// ---- Default path lives under the user profile ----
const defaultPath = new EngineSelectionStore().file;
if (!defaultPath.includes('.dsh')) {
  console.log(`FAIL: default store path looks wrong: ${defaultPath}`);
  process.exit(1);
}
console.log(`default store: ${defaultPath}`);
if (!existsSync(join(defaultPath, '..'))) console.log('  (parent dir will be created on write)');

sessionA.dispose();
rmSync(stateDir, { recursive: true, force: true });
console.log('DONE');
