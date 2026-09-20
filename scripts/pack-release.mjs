/**
 * pack-release.mjs — build a self-contained release artifact.
 *
 * A bundle that ships only `cordis.patch.yml` cannot run on a fresh machine:
 * the patch points at `@ue-bridge/dsh-plugin` and at the gateway, and neither
 * is in the tarball. This script produces one tarball containing the patch
 * PLUS the plugin, contracts, and gateway, all compiled to plain JS.
 *
 * Compiled JS is not cosmetic. Node refuses to strip TypeScript types for
 * files under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING),
 * which is exactly where dsh installs profile plugins. Shipping `src/*.ts`
 * would fail on every install.
 *
 * npm pack always excludes a top-level node_modules, so the packages travel as
 * `packages/` and install.mjs moves them into place after unpacking. The
 * compiled gateway imports contracts by a relative path, which only resolves
 * while that sibling layout is preserved, hence the flat copy rather than a
 * reshape.
 *
 * Output: dist-release/ue-bridge-bundle-<version>.tgz
 *
 * Usage: node scripts/pack-release.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, writeFileSync, copyFileSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const staging = join(root, 'dist-release', 'staging');
const outDir = join(root, 'dist-release');

// Build first: the staging tree is assembled from compiled output only.
execFileSync('node', ['scripts/build-plugin.mjs'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
}

// Sibling layout, exactly as it will be installed: gateway/dist sits beside
// contracts/dist so the relative import between them keeps resolving.
const packagesDir = join(staging, 'packages');
copyDir(join(root, 'packages', 'dsh-plugin', 'dist'), join(packagesDir, 'dsh-plugin', 'dist'));
copyDir(join(root, 'packages', 'contracts', 'dist'), join(packagesDir, 'contracts', 'dist'));
copyDir(join(root, 'packages', 'gateway', 'dist'), join(packagesDir, 'gateway', 'dist'));

/** Rewrite an installed manifest for standalone use. */
function stagePackage(name, main) {
  const dir = join(packagesDir, name);
  const manifest = JSON.parse(
    readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'),
  );
  manifest.private = false;
  manifest.version = version;
  manifest.type = 'module';
  manifest.main = main;
  if (name === 'contracts') {
    manifest.exports = {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './model-tools': { types: './dist/model-tools.d.ts', default: './dist/model-tools.js' },
      './ipc': { types: './dist/ipc.d.ts', default: './dist/ipc.js' },
      './results': { types: './dist/results.d.ts', default: './dist/results.js' },
    };
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

stagePackage('dsh-plugin', './dist/index.js');
stagePackage('contracts', './dist/index.js');
stagePackage('gateway', './dist/main.js');

// The gateway needs the MCP SDK at runtime; it is vendored so the install
// never depends on the publishing machine's node_modules.
const sdkSrc = join(root, 'node_modules', '@modelcontextprotocol', 'sdk');
if (!existsSync(sdkSrc)) {
  throw new Error(`MCP SDK not found at ${sdkSrc}; run an install at the repo root first`);
}
copyDir(sdkSrc, join(packagesDir, 'vendor', '@modelcontextprotocol', 'sdk'));

// The patch, shipped at the tarball root where dsh reads it.
copyFileSync(join(root, 'packages', 'bundle', 'cordis.patch.yml'), join(staging, 'cordis.patch.yml'));

// Re-check the patch rather than rewriting it: a patch pointing at
// `src/main.ts` would fail on every install, since Node cannot strip types
// under node_modules. Only real config values count; the comment in the file
// explains the same rule and must not trip this guard.
const patchConfig = readFileSync(join(staging, 'cordis.patch.yml'), 'utf8')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');
if (
  patchConfig.includes('--experimental-strip-types') ||
  patchConfig.includes('packages/gateway/src')
) {
  throw new Error(
    'patch still references the TS gateway entry; compiled output is required under node_modules',
  );
}

// The tarball must BE the bundle package: dsh installs it as a dependency and
// reads its dsh.bundle.patch.
const bundleManifest = JSON.parse(
  readFileSync(join(root, 'packages', 'bundle', 'package.json'), 'utf8'),
);
bundleManifest.version = version;
bundleManifest.private = false;
delete bundleManifest.files;
delete bundleManifest.dependencies;
writeFileSync(join(staging, 'package.json'), `${JSON.stringify(bundleManifest, null, 2)}\n`, 'utf8');

copyFileSync(join(root, 'README.md'), join(staging, 'README.md'));
if (existsSync(join(root, 'LICENSE'))) {
  copyFileSync(join(root, 'LICENSE'), join(staging, 'LICENSE'));
}

execFileSync('npm', ['pack', '--pack-destination', outDir], {
  cwd: staging,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

// Guard: a tarball without the compiled packages is a patch with no code
// behind it, and installs cleanly only to fail at first gateway start.
const produced = join(outDir, `ue-bridge-bundle-${version}.tgz`);
const listed = execFileSync('tar', ['-tzf', produced], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
for (const required of [
  'packages/gateway/dist/main.js',
  'packages/dsh-plugin/dist/index.js',
  'packages/contracts/dist/index.js',
  'packages/vendor/@modelcontextprotocol/sdk/package.json',
  'cordis.patch.yml',
]) {
  if (!listed.includes(required)) {
    throw new Error(`release tarball is missing ${required}; contents:\n${listed}`);
  }
}
console.log(`pack-release: ${produced}`);
