/**
 * deploy.mjs — build the plugin and install it into a dsh profile.
 *
 * dsh loads plugins from the profile's node_modules, where Node refuses to
 * strip TypeScript types, so the plugin is compiled to plain JS first.
 *
 * The bundle package is installed as well, so `dsh plugin add` can register it
 * by installed state (see docs/setup.md).
 *
 * Usage: node scripts/deploy.mjs [profileName]   (default: ue-bridge)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, copySyncSafe } from './fs-util.mjs';

const profile = process.argv[2] ?? 'ue-bridge';
const profileDir = `${process.env.USERPROFILE}/.dsh/profiles/${profile}`;
const dst = `${profileDir}/node_modules/@ue-bridge`;

if (!existsSync(profileDir)) {
  console.error(`profile not found: ${profileDir}`);
  console.error(`create it first: dsh --profile ${profile} --from-default-profile headless`);
  process.exit(1);
}

execFileSync('node', ['scripts/build-plugin.mjs'], { stdio: 'inherit', shell: true });

mkdirSync(`${dst}/dsh-plugin`, { recursive: true });
mkdirSync(`${dst}/contracts`, { recursive: true });
mkdirSync(`${dst}/bundle`, { recursive: true });

// Replace rather than merge, so stale JS never survives a rebuild.
for (const pkg of ['dsh-plugin', 'contracts', 'bundle']) {
  rmSync(`${dst}/${pkg}/dist`, { recursive: true, force: true });
}
rmSync(`${dst}/bundle/cordis.patch.yml`, { force: true });

copySyncSafe('packages/dsh-plugin/dist', `${dst}/dsh-plugin/dist`);
copySyncSafe('packages/contracts/dist', `${dst}/contracts/dist`);
// The bundle is a patch document plus its manifest, not compiled output.
copySyncSafe('packages/bundle/cordis.patch.yml', `${dst}/bundle/cordis.patch.yml`);
copySyncSafe('packages/bundle/package.json', `${dst}/bundle/package.json`);

console.log(`deploy: installed into ${dst}`);
console.log('next: add @ue-bridge/bundle to the profile bundles (see docs/setup.md)');
