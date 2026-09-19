/**
 * The user chose option two: resolve confidently and say so, ask only when
 * genuinely ambiguous.
 *
 * So this checks the boundary in both directions. A project whose .uproject
 * names a real installed engine must NOT be asked. A project that merely sits
 * under an engine, with nothing saying which one it means, MUST be asked —
 * even though an engine was found, because finding one above the project is
 * a fact about the filesystem, not about intent.
 */

import { resolveEngineRoot, enumerateEngineInstallations } from '../packages/dsh-plugin/src/toolchain.ts';

const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');

const installed = await enumerateEngineInstallations();
if (installed.length < 1) {
  console.log('FAIL: no installed engines');
  process.exit(1);
}
// Prefer a launcher release: it is what an association-based project names.
const target = installed.find((e) => e.identifier.startsWith('UE_') || /^\d/.test(e.identifier)) ?? installed[0];
console.log(`target engine: ${target.identifier} @ ${target.root}`);

const tmp = mkdtempSync(join(tmpdir(), 'dsh-conf-'));

/** Mirrors tools.ts: confident, or does it need asking? */
function highConfidence(e: Awaited<ReturnType<typeof resolveEngineRoot>>): boolean {
  if (!e?.engineRoot) return false;
  if (e.source === 'config' || e.source === 'association' || e.source === 'association-path') {
    return e.validRootDirectory && e.buildBatFound;
  }
  return false;
}

// ---- Case 1: association names a real installed engine -> no question ----
const assocRoot = join(tmp, 'Assoc');
mkdirSync(assocRoot, { recursive: true });
const assocUproj = join(assocRoot, 'Assoc.uproject');
writeFileSync(assocUproj, JSON.stringify({ EngineAssociation: target.identifier }));
const r1 = await resolveEngineRoot(assocRoot, { EngineAssociation: target.identifier }, undefined, assocUproj);
console.log(`\n[association] source=${r1.source} root=${r1.engineRoot ?? '(none)'}`);
if (!highConfidence(r1)) {
  console.log('FAIL: an association matching a real install should not be ambiguous');
  process.exit(1);
}
console.log('  -> high confidence, used without asking');

// ---- Case 2: no association, but an engine sits above -> must ask ----
// Reproduced by placing a project under a valid engine root's ancestry.
const parentRoot = join(tmp, 'Parent');
const fakeEngine = join(parentRoot, 'Engine');
mkdirSync(join(fakeEngine, 'Binaries'), { recursive: true });
mkdirSync(join(fakeEngine, 'Build', 'BatchFiles'), { recursive: true });
writeFileSync(join(fakeEngine, 'Build', 'BatchFiles', 'Build.bat'), '@echo off\n');
const projRoot = join(parentRoot, 'Proj');
mkdirSync(projRoot, { recursive: true });
const parentUproj = join(projRoot, 'Proj.uproject');
writeFileSync(parentUproj, JSON.stringify({ EngineVersion: '5.0.0' }));
const r2 = await resolveEngineRoot(projRoot, {}, undefined, parentUproj);
console.log(`\n[parent-directory] source=${r2.source} root=${r2.engineRoot ?? '(none)'}`);
if (r2.source !== 'parent-directory') {
  console.log(`FAIL: expected parent-directory, got ${r2.source}`);
  process.exit(1);
}
if (highConfidence(r2)) {
  console.log('FAIL: an engine merely found above the project must not count as confident');
  process.exit(1);
}
console.log('  -> ambiguous, user is asked');

// ---- Case 3: association naming nothing installed -> must ask ----
const badRoot = join(tmp, 'Bad');
mkdirSync(badRoot, { recursive: true });
const badUproj = join(badRoot, 'Bad.uproject');
writeFileSync(badUproj, JSON.stringify({ EngineAssociation: '9.9-nonexistent' }));
const r3 = await resolveEngineRoot(badRoot, { EngineAssociation: '9.9-nonexistent' }, undefined, badUproj);
console.log(`\n[unknown association] source=${r3.source}`);
if (highConfidence(r3)) {
  console.log('FAIL: an association matching no install must not be confident');
  process.exit(1);
}
console.log(`  -> ambiguous, user is asked: ${r3.reason?.slice(0, 70)}...`);

// ---- Case 4: explicit config is confident, but a broken path is not ----
const explicitOk = await resolveEngineRoot(assocRoot, undefined, target.root);
console.log(`\n[explicit] source=${explicitOk.source} valid=${explicitOk.validRootDirectory} bat=${explicitOk.buildBatFound}`);
if (!highConfidence(explicitOk)) {
  console.log('FAIL: an explicit engine root should be confident');
  process.exit(1);
}
console.log('  -> high confidence');

const broken = await resolveEngineRoot(assocRoot, undefined, join(tmp, 'NotAnEngine'));
console.log(`\n[explicit broken] source=${broken.source} valid=${broken.validRootDirectory}`);
if (highConfidence(broken)) {
  console.log('FAIL: a path that is not an engine root must not be confident');
  process.exit(1);
}
console.log('  -> structural check gates confidence');

rmSync(tmp, { recursive: true, force: true });
console.log('\nDONE: confident resolutions are used and reported; only ambiguity asks');
