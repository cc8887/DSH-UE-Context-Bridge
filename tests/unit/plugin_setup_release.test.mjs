/**
 * Confirms the live GeneralBlueprint release index and the UE 5.8.1 module
 * manifest. This does not download the whole zip; it reads the central
 * directory and inflates UnrealEditor.modules.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { OBSERVED_UE581 } from '../../packages/dsh-plugin/src/plugin-setup/constants.ts';
import { loadReleaseIndex, selectReleaseAsset } from '../../packages/dsh-plugin/src/plugin-setup/release-index.ts';

test('published releases match the compatibility matrix', async () => {
  const assets = await loadReleaseIndex();
  const names = new Set(assets.map((item) => `${item.tag}/${item.name}`));
  for (const label of ['4.26', '4.27', '5.0', '5.1', '5.2', '5.3', '5.4', '5.5', '5.6', '5.7', '5.8']) {
    assert.equal(names.has(`v1.0.0-beta.1/GeneralBlueprint-UE_${label}-Win64.zip`), true, label);
  }
  const exact = selectReleaseAsset({ major: 5, minor: 8, patch: 1 }, assets);
  assert.equal(exact.ok, true);
  assert.equal(exact.asset.name, OBSERVED_UE581.asset);
  assert.equal(exact.asset.sha256, OBSERVED_UE581.sha256);
  assert.equal(exact.asset.sha256From, 'github-digest+sums');
  assert.equal(selectReleaseAsset({ major: 5, minor: 4, patch: 4 }, assets).asset.name, 'GeneralBlueprint-UE_5.4-Win64.zip');
  assert.equal(selectReleaseAsset({ major: 5, minor: 8, patch: 2 }, assets).ok, false);
});

test('UE 5.8.1 UnrealEditor.modules BuildId is 55116800, not the validation CL', async () => {
  const manifest = await readRemoteModules(
    'https://github.com/cc8887/GeneralBlueprint/releases/download/v1.1.0-beta.1/GeneralBlueprint-UE_5.8.1-Win64.zip',
    236105773,
  );
  assert.equal(manifest.BuildId, OBSERVED_UE581.modulesBuildId);
  assert.notEqual(manifest.BuildId, OBSERVED_UE581.validationChangelist);
  assert.ok(manifest.Modules.BlueprintLisp);
});

async function readRemoteModules(url, size) {
  let current = url;
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await fetch(current, { redirect: 'manual', headers: { range: 'bytes=0-0' } });
    if (response.status >= 300 && response.status < 400) {
      current = new URL(response.headers.get('location'), current).toString();
      continue;
    }
    if (response.status === 200 || response.status === 206) break;
    throw new Error(`expected a redirect or the zip, got HTTP ${response.status}`);
  }
  const start = size - 400000;
  const tailResponse = await fetch(current, { headers: { range: `bytes=${start}-${size - 1}` } });
  const tail = Buffer.from(await tailResponse.arrayBuffer());
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const cdOffset = tail.readUInt32LE(eocd + 16);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cd = tail.subarray(cdOffset - start, cdOffset - start + cdSize);
  let pos = 0;
  let entry;
  while (pos + 46 <= cd.length) {
    const nameLength = cd.readUInt16LE(pos + 28);
    const extraLength = cd.readUInt16LE(pos + 30);
    const commentLength = cd.readUInt16LE(pos + 32);
    const name = cd.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
    if (name.endsWith('UnrealEditor.modules')) {
      entry = {
        method: cd.readUInt16LE(pos + 10),
        compressedSize: cd.readUInt32LE(pos + 20),
        localOffset: cd.readUInt32LE(pos + 42),
      };
      break;
    }
    pos += 46 + nameLength + extraLength + commentLength;
  }
  if (!entry) throw new Error('UnrealEditor.modules is not in the release zip');
  const local = await fetch(current, {
    headers: { range: `bytes=${entry.localOffset}-${entry.localOffset + 400}` },
  });
  const blob = Buffer.from(await local.arrayBuffer());
  const nameLength = blob.readUInt16LE(26);
  const extraLength = blob.readUInt16LE(28);
  const compressed = blob.subarray(30 + nameLength + extraLength, 30 + nameLength + extraLength + entry.compressedSize);
  return JSON.parse(inflateRawSync(compressed).toString('utf8'));
}
