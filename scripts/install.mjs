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

import { readFileSync, existsSync, mkdirSync, cpSync, rmSync } from 'node:fs';
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
// resolves them for the gateway.
const vendorDir = join(packagesDir, 'vendor');
if (existsSync(vendorDir)) {
  const nmRoot = join(profileDir, 'node_modules');
  for (const scope of ['@modelcontextprotocol']) {
    const src = join(vendorDir, scope);
    if (!existsSync(src)) continue;
    for (const pkg of ['sdk']) {
      const from = join(src, pkg);
      const to = join(nmRoot, scope, pkg);
      if (!existsSync(from)) continue;
      rmSync(to, { recursive: true, force: true });
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to, { recursive: true });
      console.log(`install: ${to}`);
    }
  }
}

console.log(`install: ue-bridge ready in profile "${profile}"`);
console.log('verify: dsh --profile ' + profile + '  (then ask for ue_find / ue_python_execute)');
