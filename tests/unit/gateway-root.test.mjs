/**
 * gateway-root.test.mjs — the bundle patch must carry no absolute path.
 *
 * The gateway is found by shape (the directory containing `src/main.ts`), so
 * the same patch works after the clone moves or on another machine. These
 * cases stage both real layouts under os.tmpdir() and assert each resolves,
 * plus the negative case where no gateway exists at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveGatewayLocation } from '../../packages/dsh-plugin/src/gateway-root.ts';

/** Build `<root>/packages/gateway/src/main.ts`, the layout of a clone. */
function stageCloneLayout(root) {
  mkdirSync(join(root, 'packages', 'gateway', 'src'), { recursive: true });
  writeFileSync(join(root, 'packages', 'gateway', 'src', 'main.ts'), '// gateway\n');
}

/** Build `<root>/node_modules/@ue-bridge/gateway/src/main.ts`, an install. */
function stageInstallLayout(root) {
  mkdirSync(join(root, 'node_modules', '@ue-bridge', 'gateway', 'src'), { recursive: true });
  writeFileSync(join(root, 'node_modules', '@ue-bridge', 'gateway', 'src', 'main.ts'), '// gateway\n');
}

/** A module URL inside the dsh-plugin package, as the plugin would see it. */
function pluginModuleUrl(pluginDir) {
  return pathToFileURL(join(pluginDir, 'src', 'index.js')).href;
}

test('finds the gateway in a clone layout', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gw-clone-'));
  stageCloneLayout(root);
  const pluginDir = join(root, 'packages', 'dsh-plugin');
  mkdirSync(join(pluginDir, 'src'), { recursive: true });

  const found = resolveGatewayLocation(pluginModuleUrl(pluginDir));
  assert.ok(found, 'gateway should be found in a clone layout');
  assert.equal(found.main, 'src/main.ts');
  assert.equal(found.cwd, join(root, 'packages', 'gateway'));
});

test('finds the gateway in a profile install layout', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gw-install-'));
  stageInstallLayout(root);
  const pluginDir = join(root, 'node_modules', '@ue-bridge', 'dsh-plugin');
  mkdirSync(join(pluginDir, 'src'), { recursive: true });

  const found = resolveGatewayLocation(pluginModuleUrl(pluginDir));
  assert.ok(found, 'gateway should be found when installed in a profile');
  assert.equal(found.cwd, join(root, 'node_modules', '@ue-bridge', 'gateway'));
});

test('returns undefined when no gateway is installed beside the plugin', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gw-none-'));
  const pluginDir = join(root, 'node_modules', '@ue-bridge', 'dsh-plugin');
  mkdirSync(join(pluginDir, 'src'), { recursive: true });

  assert.equal(
    resolveGatewayLocation(pluginModuleUrl(pluginDir)),
    undefined,
    'absent gateway must report undefined, not a wrong guess',
  );
});

// A release install ships compiled JS, because Node refuses to strip types
// under node_modules. That entry must win over the source one.
test('prefers the compiled gateway entry when both exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gw-both-'));
  stageInstallLayout(root);
  const gwRoot = join(root, 'node_modules', '@ue-bridge', 'gateway');
  mkdirSync(join(gwRoot, 'dist'), { recursive: true });
  writeFileSync(join(gwRoot, 'dist', 'main.js'), '// compiled gateway\n');

  const pluginDir = join(root, 'node_modules', '@ue-bridge', 'dsh-plugin');
  mkdirSync(join(pluginDir, 'src'), { recursive: true });

  const found = resolveGatewayLocation(pluginModuleUrl(pluginDir));
  assert.ok(found, 'gateway should be found');
  assert.equal(found.compiled, true, 'compiled entry must be selected');
  assert.equal(found.main, 'dist/main.js', 'path must use forward slashes on every platform');
});

test('reports a source entry as not compiled', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gw-src-'));
  stageCloneLayout(root);
  const pluginDir = join(root, 'packages', 'dsh-plugin');
  mkdirSync(join(pluginDir, 'src'), { recursive: true });

  const found = resolveGatewayLocation(pluginModuleUrl(pluginDir));
  assert.equal(found?.compiled, false, 'a TS entry needs the type-stripping flag');
  assert.equal(found?.main, 'src/main.ts');
});

test('resolves from the real repository without configuration', () => {
  // Anchor: this test file always ships inside the repository.
  const repoRoot = join(import.meta.dirname, '..', '..');
  const pluginDir = join(repoRoot, 'packages', 'dsh-plugin');
  const found = resolveGatewayLocation(pluginModuleUrl(pluginDir));
  assert.ok(found, 'the real repo layout must resolve the gateway');
  assert.equal(found.cwd, join(repoRoot, 'packages', 'gateway'));
});
