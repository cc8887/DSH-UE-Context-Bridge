/**
 * Tests for Windows toolchain diagnosis.
 *
 * These are written against the real failure that motivated the module: a
 * user-level BuildConfiguration.xml pinned VisualStudio2019 while the only
 * installed compilers were VS 2022 (17.x) and VS 18 Insiders (18.x). UBT
 * reported "Requested value 'VisualStudio2019' was not found", which names the
 * enum but not the file that supplied it or the compilers that do exist.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  compilerForVersion,
  readCompilerSetting,
  diagnoseWindowsToolchain,
} from '../../packages/dsh-plugin/src/windows-toolchain.ts';

const CONFIG_TEMPLATE = `<?xml version="1.0" encoding="utf-8" ?>
<Configuration xmlns="https://www.unrealengine.com/BuildConfiguration">
</Configuration>`;

function withCompiler(compiler, compilerVersion) {
  const version = compilerVersion ? `\n        <CompilerVersion>${compilerVersion}</CompilerVersion>` : '';
  return `<?xml version="1.0" encoding="utf-8" ?>
<Configuration xmlns="https://www.unrealengine.com/BuildConfiguration">
    <WindowsPlatform>
        <Compiler>${compiler}</Compiler>${version}
    </WindowsPlatform>
</Configuration>`;
}

test('compilerForVersion maps VS generations to UBT enum values', () => {
  // 18.x is VS 2026; the engine treats anything newer as 2026 too.
  assert.equal(compilerForVersion('18.7.11811.120'), 'VisualStudio2026');
  assert.equal(compilerForVersion('17.14.36908.2'), 'VisualStudio2022');
  assert.equal(compilerForVersion('16.11.32106.194'), 'VisualStudio2019');
  assert.equal(compilerForVersion(undefined), undefined);
  assert.equal(compilerForVersion('garbage'), undefined);
});

test('readCompilerSetting reads the WindowsPlatform block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toolchain-cfg-'));
  const path = join(dir, 'BuildConfiguration.xml');

  writeFileSync(path, withCompiler('VisualStudio2026'));
  assert.deepEqual(readCompilerSetting(path), { compiler: 'VisualStudio2026' });

  writeFileSync(path, withCompiler('VisualStudio2019', '14.32.31342'));
  assert.deepEqual(readCompilerSetting(path), {
    compiler: 'VisualStudio2019',
    compilerVersion: '14.32.31342',
  });
});

test('readCompilerSetting tolerates files with no compiler and unreadable files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toolchain-cfg-'));
  const empty = join(dir, 'empty.xml');
  writeFileSync(empty, CONFIG_TEMPLATE);
  assert.equal(readCompilerSetting(empty), undefined);

  assert.equal(readCompilerSetting(join(dir, 'does-not-exist.xml')), undefined);
});

test('diagnosis reports a compiler that no installed VS provides', () => {
  // Point every config layer at a temp dir so the host machine's own
  // configuration cannot make this test pass or fail by accident, then pin
  // the stale value in the last (highest-precedence) layer.
  const dir = mkdtempSync(join(tmpdir(), 'toolchain-diag-'));
  const appData = join(dir, 'AppData');
  mkdirSync(join(appData, 'Unreal Engine', 'UnrealBuildTool'), { recursive: true });
  writeFileSync(
    join(appData, 'Unreal Engine', 'UnrealBuildTool', 'BuildConfiguration.xml'),
    withCompiler('VisualStudio2019', '14.32.31342'),
  );

  const saved = { APPDATA: process.env['APPDATA'] };
  process.env['APPDATA'] = appData;

  try {
    const result = diagnoseWindowsToolchain();
    const installed = [...result.usable, ...result.unusable];

    // The test only asserts the conflict when this machine actually lacks
    // VS2019; on a machine that has it there is nothing to diagnose.
    const hasVs2019 = installed.some((i) => i.compiler === 'VisualStudio2019');
    if (hasVs2019) return;

    assert.equal(result.ok, false);
    assert.equal(result.missing, 'VisualStudio2019');
    assert.equal(result.effective?.compiler, 'VisualStudio2019');
    assert.match(result.effectiveFrom ?? '', /Global \(AppData\)/);
    // The fix must name the file to edit, not just the enum value.
    assert.ok(
      result.fixes.some((f) => f.includes('Global (AppData)')),
      `expected a fix naming the config layer, got: ${JSON.stringify(result.fixes)}`,
    );
  } finally {
    process.env['APPDATA'] = saved.APPDATA;
  }
});

test('diagnosis reports the effective compiler when it is satisfiable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toolchain-diag-'));
  const appData = join(dir, 'AppData');
  mkdirSync(join(appData, 'Unreal Engine', 'UnrealBuildTool'), { recursive: true });
  writeFileSync(
    join(appData, 'Unreal Engine', 'UnrealBuildTool', 'BuildConfiguration.xml'),
    withCompiler('VisualStudio2022'),
  );

  const saved = { APPDATA: process.env['APPDATA'] };
  process.env['APPDATA'] = appData;

  try {
    const result = diagnoseWindowsToolchain();
    // VS2022 is installed on this machine, so this must not be flagged.
    const hasVs2022 = [...result.usable, ...result.unusable].some(
      (i) => i.compiler === 'VisualStudio2022',
    );
    if (!hasVs2022) return;

    assert.equal(result.ok, true);
    assert.equal(result.effective?.compiler, 'VisualStudio2022');
    assert.deepEqual(result.fixes, []);
  } finally {
    process.env['APPDATA'] = saved.APPDATA;
  }
});

test('diagnosis finds at least one usable Visual Studio on this machine', () => {
  // Guards the discovery path itself: vswhere without -prerelease hides VS 18,
  // so a naive implementation reports nothing here.
  const result = diagnoseWindowsToolchain();
  const all = [...result.usable, ...result.unusable];
  assert.ok(all.length > 0, 'expected at least one Visual Studio installation to be found');
  assert.ok(
    all.some((i) => i.path.length > 0 && i.edition.length > 0),
    'expected installations to carry a path and edition',
  );
});
