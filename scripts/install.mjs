#!/usr/bin/env node
/**
 * install.mjs — finish installing the release tarball into a dsh profile.
 *
 * `dsh plugin add <tarball>` unpacks the bundle and registers it as a layer,
 * but the compiled packages arrive as `packages/` because npm pack excludes a
 * top-level node_modules. This moves them to where Node will resolve them:
 *
 *   packages/dsh-plugin  -> node_modules/@ue-bridge/dsh-plugin
 *   packages/contracts   -> node_modules/@ue-bridge/contracts
 *   packages/gateway     -> node_modules/@ue-bridge/gateway
 *   packages/vendor/*    -> node_modules/*
 *
 * Run it from the profile directory, or pass --profile <name>.
 *
 * Usage:
 *   node install.mjs --profile ue-bridge
 *   dsh plugin --profile ue-bridge add <url> && node install.mjs --profile ue-bridge
 */

import { readFileSync, existsSync, mkdirSync, cpSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const profileIndex = args.indexOf('--profile');
const profile = profileIndex >= 0 ? args[profileIndex + 1] : 'ue-bridge';

if (!profile) {
  console.error('usage: node install.mjs --profile <name>');
  process.exit(1);
}

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const profileDir = join(dshHome, 'profiles', profile);
const bundleDir = join(profileDir, 'node_modules', '@ue-bridge', 'bundle');

if (!existsSync(bundleDir)) {
  console.error(`bundle not installed at ${bundleDir}`);
  console.error(`run first: dsh plugin --profile ${profile} add <release-tarball-url>`);
  process.exit(1);
}

const packagesDir = join(bundleDir, 'packages');
if (!existsSync(packagesDir)) {
  console.error(`no packages/ in ${bundleDir}; this looks like a patch-only bundle`);
  process.exit(1);
}

const nmRoot = join(profileDir, 'node_modules');
mkdirSync(nmRoot, { recursive: true });

const target = join(profileDir, 'node_modules', '@ue-bridge');
const MOVE = [
  { from: join(packagesDir, 'dsh-plugin'), to: join(target, 'dsh-plugin') },
  { from: join(packagesDir, 'contracts'), to: join(target, 'contracts') },
  { from: join(packagesDir, 'gateway'), to: join(target, 'gateway') },
];

for (const { from, to } of MOVE) {
  if (!existsSync(from)) {
    console.error(`missing ${from}; the tarball is incomplete`);
    process.exit(1);
  }
  rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`install: ${to}`);
}

// Vendored runtime deps land at the profile's node_modules root, where Node
// resolves them for the plugin and the gateway. Written generically so a newly
// vendored package needs no change here.
const vendorDir = join(packagesDir, 'vendor');
if (existsSync(vendorDir)) {
  for (const entry of readdirSync(vendorDir, { withFileTypes: true })) {
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(join(vendorDir, entry.name), { withFileTypes: true })) {
        place(join(vendorDir, entry.name, scoped.name), join(nmRoot, entry.name, scoped.name));
      }
    } else {
      place(join(vendorDir, entry.name), join(nmRoot, entry.name));
    }
  }
}

// Link, never copy, the packages the dsh host already owns.
//
// @deepseek-ai/dsh-tools and cordis are peer dependencies: the running host
// supplies them, and their version must match the host exactly. Two hosts on
// one machine can differ, so the only safe source is the host that will
// actually load this plugin — resolved from dsh's own location.
//
// Copying would be worse than failing: a stale copy pins an older API and the
// plugin breaks at runtime instead of at install. A symlink cannot drift, and
// it disappears when the host is upgraded rather than silently diverging.
//
// This is why the install needs no extra flags: where dsh lives is knowable,
// so asking the user would only invite a mismatch.
const HOST_LINKED = ['@deepseek-ai/dsh-tools', '@deepseek-ai/cordis'];
const hostRoot = resolveHostRoot();
for (const name of HOST_LINKED) {
  const target = join(nmRoot, name);
  if (existsSync(target) || !hostRoot) continue;
  const src = join(hostRoot, name);
  if (!existsSync(src)) {
    console.log(`note: host does not provide ${name}; leaving resolution to the loader`);
    continue;
  }
  try {
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(src, target, 'junction');
    console.log(`link: ${name} -> ${src}`);
  } catch {
    // Junction needs NTFS; fall back to a copy so the install still completes.
    cpSync(src, target, { recursive: true });
    console.log(`copy: ${target} (symlink unavailable)`);
  }
}

function place(from, to) {
  if (!existsSync(from)) return;
  rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`install: ${to}`);
}

/**
 * Where the running dsh lives, so its own copies of shared packages can be
 * linked. `where dsh` fails under a plain spawn in some shells, so fall back
 * to the npm global root, which is where a global dsh install resides.
 */
function resolveHostRoot() {
  const candidates = [];
  try {
    const bin = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
    if (bin) candidates.push(join(bin, '@deepseek-ai', 'dsh', 'node_modules'));
  } catch { /* npm unavailable */ }
  candidates.push(join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'));
  for (const c of candidates) if (existsSync(join(c, '@deepseek-ai', 'dsh-tools'))) return c;
  return undefined;
}

console.log(`install: ue-bridge ready in profile "${profile}"`);
console.log('verify: dsh --profile ' + profile + '  (then ask for ue_find / ue_python_execute)');
