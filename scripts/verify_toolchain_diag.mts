// Regression: compiler toolchain diagnosis must fire on the "requested VS is
// missing" failure and stay silent on a healthy build.
// Uses the real UE + Lyra (no stand-ins), per project testing policy.

import { EditorSession } from '../packages/dsh-plugin/src/editor-lifecycle.ts';
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE_ROOT, PROJECT_ROOT, requireRealPath } from './paths.mts';

// Placeholder defaults keep the committed file free of machine-specific paths.
// Lyra is the default project because it ships with the engine source tree.
const engineRoot = requireRealPath('UE_ENGINE_ROOT', ENGINE_ROOT);
const projectRoot = requireRealPath(
  'UE_PROJECT_ROOT or UE_ENGINE_ROOT',
  process.env.UE_PROJECT_ROOT ?? `${engineRoot}/Samples/Games/Lyra`,
);
const APPDATA = process.env.APPDATA!;
const CONFIG_DIR = join(APPDATA, 'Unreal Engine', 'UnrealBuildTool');
const CONFIG = join(CONFIG_DIR, 'BuildConfiguration.xml');

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` :: ${detail}` : ''}`);
  if (!cond) failures++;
}

function session() {
  return new EditorSession({
    projectRoot,
    projectName: 'Lyra',
    engineRoot,
    target: 'LyraEditor',
  });
}

// --- helpers to stage/restore the AppData config -------------------------
const backup = `${CONFIG}.dshregress.${Date.now()}.bak`;
const hadConfig = existsSync(CONFIG);
if (hadConfig) copyFileSync(CONFIG, backup);

function writeConfig(compiler: string | null) {
  const body = compiler
    ? `\n    <WindowsPlatform>\n        <Compiler>${compiler}</Compiler>\n    </WindowsPlatform>\n`
    : '';
  writeFileSync(
    CONFIG,
    `<?xml version="1.0" encoding="utf-8" ?>\n<Configuration xmlns="https://www.unrealengine.com/BuildConfiguration">${body}</Configuration>\n`,
    'utf8',
  );
}

function restore() {
  if (hadConfig) copyFileSync(backup, CONFIG);
  else if (existsSync(CONFIG)) rmSync(CONFIG);
  if (existsSync(backup)) rmSync(backup);
}

try {
  // === Case 1: healthy — no Compiler override, engine default in effect ===
  console.log('--- case 1: healthy build (no override) ---');
  writeConfig(null);
  // No force: each case builds a brand-new session, which starts with no
  // cached verdict to bypass, so force would be a no-op here.
  const good = await session().build();
  check('healthy build succeeds', good.ok === true, `ok=${good.ok} exit=${good.exitCode}`);
  check(
    'healthy build emits no toolchain diagnosis',
    !good.toolchain,
    good.toolchain ? JSON.stringify(good.toolchain).slice(0, 200) : 'silent',
  );

  // === Case 2: broken — request a VS that is NOT installed ===
  console.log('--- case 2: missing compiler (VisualStudio2019) ---');
  writeConfig('VisualStudio2019');
  const bad = await session().build();
  check('broken build fails', bad.ok === false, `ok=${bad.ok} exit=${bad.exitCode}`);
  check('toolchain diagnosis attached', !!bad.toolchain, bad.toolchain ? 'attached' : 'MISSING');

  const t: any = bad.toolchain ?? {};
  check('diagnosis reports ok=false', t.ok === false, `ok=${t.ok}`);
  check(
    'diagnosis names the effective compiler',
    t.effective?.compiler === 'VisualStudio2019',
    `effective=${t.effective?.compiler}`,
  );
  check(
    'diagnosis points at the AppData config file',
    /AppData/.test(t.effectiveFrom ?? ''),
    `effectiveFrom=${t.effectiveFrom}`,
  );
  check(
    'diagnosis lists usable alternative compilers',
    Array.isArray(t.usable) && t.usable.length > 0,
    `usable=${(t.usable ?? []).map((u: any) => u.compiler ?? '?').join(', ')}`,
  );
  check(
    'diagnosis does not claim the missing VS is unusable-by-engine',
    Array.isArray(t.unusable),
    `unusable=${(t.unusable ?? []).length} (absent VS is reported via missing, not unusable)`,
  );
  check('diagnosis offers fixes', Array.isArray(t.fixes) && t.fixes.length > 0, `fixes=${(t.fixes ?? []).length}`);
  check(
    'diagnosis marks VisualStudio2019 as missing',
    (t.missing ?? '') === 'VisualStudio2019',
    `missing=${t.missing}`,
  );
  check(
    'diagnosis enumerates config layers',
    Array.isArray(t.configs) && t.configs.some((c: any) => /AppData/.test(c.path) && c.exists),
    `layers=${(t.configs ?? []).filter((c: any) => c.exists).map((c: any) => c.layer).join(', ')}`,
  );

  // === Case 3: recovery — removing the override restores the build ===
  console.log('--- case 3: recovery after restoring config ---');
  writeConfig(null);
  const healed = await session().build();
  check('build recovers once override is gone', healed.ok === true, `ok=${healed.ok} exit=${healed.exitCode}`);
  check('recovery emits no toolchain diagnosis', !healed.toolchain, healed.toolchain ? 'noisy' : 'silent');
} finally {
  restore();
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
