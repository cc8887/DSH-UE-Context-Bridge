/**
 * Does the build environment resolve, and can UBT confirm it?
 *
 * The claim being tested is that dsh discovers engines the way Unreal does 鈥? * launcher manifest plus per-user registry, filtered by IsValidRootDirectory 鈥? * and resolves a project's engine the way GetEngineIdentifierForProject does.
 */

import { EditorSession } from '../packages/dsh-plugin/src/editor-lifecycle.ts';
import {
  enumerateEngineInstallations,
  enumerateNativeProjects,
  isValidRootDirectory,
  resolveEngineRoot,
  validateToolchain,
} from '../packages/dsh-plugin/src/toolchain.ts';
import { REPO_ROOT, ENGINE_ROOT, requireRealPath } from './paths.mts';

const engineRoot = requireRealPath('UE_ENGINE_ROOT', ENGINE_ROOT);
const repoRoot = requireRealPath('UE_BRIDGE_REPO', REPO_ROOT);

const { readdirSync, readFileSync, mkdtempSync, writeFileSync } = await import('node:fs');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');

// ---- Discovery: every engine UE would offer on this machine ----
const installed = await enumerateEngineInstallations();
console.log(`installed engines (${installed.length}):`);
for (const e of installed) {
  console.log(
    `  ${e.identifier.padEnd(38)} ${e.via.padEnd(9)} ${e.version ?? '?'} ${e.sourceDistribution ? '[source]' : '[binary]'}  ${e.root}`,
  );
}
if (installed.length === 0) {
  console.log('FAIL: no engine installations discovered');
  process.exit(1);
}
// This machine has both a launcher release and registered source builds.
if (!installed.some((e) => e.via === 'launcher')) {
  console.log('FAIL: launcher manifest engines were not discovered');
  process.exit(1);
}
if (!installed.some((e) => e.via === 'registry')) {
  console.log('FAIL: registered source builds were not discovered');
  process.exit(1);
}
// UE's own validity test: no entry may be a non-engine lookalike.
for (const e of installed) {
  if (!isValidRootDirectory(e.root)) {
    console.log(`FAIL: ${e.root} passed discovery but fails IsValidRootDirectory`);
    process.exit(1);
  }
}
console.log('  discovery matches UE (launcher + registry), all entries valid roots');

// ---- Resolving a known launcher release by its identifier ----
const release = installed.find((e) => e.via === 'launcher');
const byId = await resolveEngineRoot(
  repoRoot,
  { EngineAssociation: release!.identifier },
  undefined,
);
console.log(
  `association "${release!.identifier}" -> ${byId.source} ${byId.engineRoot ?? '(none)'} version=${byId.engineVersion ?? '?'}`,
);
if (byId.engineRoot?.toLowerCase() !== release!.root.toLowerCase()) {
  console.log(`FAIL: identifier did not resolve to the right root`);
  process.exit(1);
}
console.log('  a launcher version string resolves without any path guessing');

// ---- Lyra: a source-tree project with an empty association ----
const projectRoot = engineRoot + '/Samples/Games/Lyra';
const uprojectPath = join(
  projectRoot,
  readdirSync(projectRoot).find((f) => f.endsWith('.uproject'))!,
);
const descriptor = JSON.parse(readFileSync(uprojectPath, 'utf8'));
console.log(`Lyra.EngineAssociation = ${JSON.stringify(descriptor.EngineAssociation)}`);

const resolved = await resolveEngineRoot(projectRoot, descriptor, undefined, uprojectPath);
console.log(`resolved via ${resolved.source}: ${resolved.engineRoot ?? '(none)'}`);
console.log(
  `  version=${resolved.engineVersion ?? '?'} sourceDistribution=${resolved.sourceDistribution} native=${resolved.native} validRoot=${resolved.validRootDirectory}`,
);
if (resolved.source !== 'parent-directory') {
  console.log(`FAIL: expected parent-directory resolution, got ${resolved.source}`);
  process.exit(1);
}
if (resolved.engineRoot?.toLowerCase() !== engineRoot.toLowerCase()) {
  console.log(`FAIL: Lyra resolved to ${resolved.engineRoot}`);
  process.exit(1);
}
// ---- UE's own native test, via .uprojectdirs ----
// The scan goes one level deep from each path in the .uprojectdirs file, so
// whether a project is native is a fact about the engine tree, not something
// to assume. Print it, then require the flag to agree with the index.
const nativeProjects = enumerateNativeProjects(resolved.engineRoot!);
console.log(`engine indexes ${nativeProjects.length} native projects:`);
for (const p of nativeProjects.slice(0, 8)) console.log(`    ${p}`);
if (nativeProjects.length > 8) console.log(`    ... ${nativeProjects.length - 8} more`);
if (nativeProjects.length === 0) {
  console.log('FAIL: .uprojectdirs scan found no projects');
  process.exit(1);
}

const lyraIndexed = nativeProjects.some(
  (p) => p.toLowerCase() === uprojectPath.replace(/\\/g, '/').toLowerCase(),
);
console.log(`  Lyra indexed=${lyraIndexed} native=${resolved.native}`);
if (resolved.native !== lyraIndexed) {
  console.log(`FAIL: native flag (${resolved.native}) disagrees with the index (${lyraIndexed})`);
  process.exit(1);
}
console.log('  native flag agrees with the engine index');

// A project outside the tree must not be reported native.
const foreign = await resolveEngineRoot(projectRoot, descriptor, undefined, '/tmp/Nope.uproject');
if (foreign.native !== false) {
  console.log('FAIL: a project outside the tree should not be native');
  process.exit(1);
}
console.log('  native/foreign discriminates correctly');

// ---- UBT's own verdict, without building ----
const t0 = Date.now();
const toolchain = await validateToolchain(resolved.engineRoot!, 'Win64');
console.log(
  `UBT ValidatePlatforms: valid=${toolchain.valid} sdk=${toolchain.sdk ?? '?'} ${Date.now() - t0}ms`,
);
if (!toolchain.valid) {
  console.log(`FAIL: UBT says the toolchain is not usable: ${toolchain.error ?? toolchain.raw}`);
  process.exit(1);
}

// ---- A stale explicit path must be reported, not silently trusted ----
const bogus = await resolveEngineRoot(projectRoot, descriptor, 'G:/does/not/exist');
console.log(`bogus explicit root: validRoot=${bogus.validRootDirectory} buildBat=${bogus.buildBatFound}`);
if (bogus.validRootDirectory || bogus.buildBatFound) {
  console.log('FAIL: a non-engine directory was reported usable');
  process.exit(1);
}
console.log(`  reason: ${bogus.reason}`);
console.log('  bad explicit path reported honestly');

// ---- An unknown identifier lists what is available ----
const unknown = await resolveEngineRoot(projectRoot, { EngineAssociation: '9.9' }, undefined);
console.log(`unknown association: ${unknown.source}`);
if (unknown.source !== 'unresolved' || !unknown.reason?.includes('9.9')) {
  console.log('FAIL: unknown association should be unresolved with a reason');
  process.exit(1);
}
console.log(`  reason: ${unknown.reason}`);

// ---- End to end through the session ----
const session = new EditorSession({ projectRoot, projectName: 'Lyra', target: 'LyraEditor' });
await session.prepare();
const snap = session.snapshot();
console.log(`snapshot.engine.source     = ${snap.engine?.source}`);
console.log(`snapshot.engine.root       = ${snap.engine?.engineRoot ?? '(none)'}`);
console.log(`snapshot.engine.identifier = ${snap.engine?.identifier ?? '(none)'}`);
if (snap.engine?.source !== 'parent-directory') {
  console.log(`FAIL: session did not resolve the engine, got ${snap.engine?.source}`);
  process.exit(1);
}
if (snap.engine?.engineRoot !== resolved.engineRoot) {
  console.log('FAIL: session engine differs from direct resolution');
  process.exit(1);
}
console.log('  session exposes the resolved engine');

// ---- An isolated project must fail loudly ----
const isolated = mkdtempSync(join(tmpdir(), 'dsh-noengine-'));
writeFileSync(join(isolated, 'Lonely.uproject'), JSON.stringify({ EngineVersion: '5.0.0' }));
const orphan = new EditorSession({ projectRoot: isolated, target: 'LonelyEditor' });
await orphan.prepare();
const orphanBuild = await orphan.build();
console.log(`orphan build: ok=${orphanBuild.ok} code=${orphanBuild.errors[0]?.code}`);
if (orphanBuild.ok) {
  console.log('FAIL: a project with no engine reported a successful build');
  process.exit(1);
}
if (orphanBuild.errors[0]?.code !== 'ENGINE_UNRESOLVED') {
  console.log(`FAIL: expected ENGINE_UNRESOLVED, got ${orphanBuild.errors[0]?.code}`);
  process.exit(1);
}
console.log(`  message: ${orphanBuild.errors[0]?.message}`);

orphan.dispose();
session.dispose();
console.log('DONE');
