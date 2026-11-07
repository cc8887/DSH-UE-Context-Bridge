/**
 * GeneralBlueprint setup: version selection, archive safety, launcher versus
 * source install, and the loopback page. Engines and release zips here are
 * fixtures. Nothing reaches a real Unreal Editor.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { compareBuildIds, readModuleManifest } from '../../packages/dsh-plugin/src/plugin-setup/build-id.ts';
import { OBSERVED_UE581 } from '../../packages/dsh-plugin/src/plugin-setup/constants.ts';
import { classifyEngineKind } from '../../packages/dsh-plugin/src/plugin-setup/engine-kind.ts';
import { selectReleaseAsset } from '../../packages/dsh-plugin/src/plugin-setup/release-index.ts';
import { extractPluginArchive, UnsafeArchiveError } from '../../packages/dsh-plugin/src/plugin-setup/safe-extract.ts';
import { startPluginSetup } from '../../packages/dsh-plugin/src/plugin-setup/server.ts';
import { stageSourceTree } from '../../packages/dsh-plugin/src/plugin-setup/source-stage.ts';

const version = (major, minor, patch) => ({ major, minor, patch });

function asset(name, tag = 'v1.0.0-beta.1') {
  const parsed = name.match(/^GeneralBlueprint-UE_(\d+)\.(\d+)(?:\.(\d+))?-Win64\.zip$/);
  return {
    tag,
    name,
    versionLabel: parsed[3] === undefined ? `${parsed[1]}.${parsed[2]}` : `${parsed[1]}.${parsed[2]}.${parsed[3]}`,
    major: Number(parsed[1]),
    minor: Number(parsed[2]),
    ...(parsed[3] === undefined ? {} : { patch: Number(parsed[3]) }),
    sha256: 'ab'.repeat(32),
    downloadUrl: `https://github.com/cc8887/GeneralBlueprint/releases/download/${tag}/${name}`,
  };
}

const PUBLISHED = [
  ...['4.26', '4.27', '5.0', '5.1', '5.2', '5.3', '5.4', '5.5', '5.6', '5.7', '5.8'].map((label) =>
    asset(`GeneralBlueprint-UE_${label}-Win64.zip`),
  ),
  asset('GeneralBlueprint-UE_5.8.1-Win64.zip', 'v1.1.0-beta.1'),
];

test('release selection follows published names and does not guess', () => {
  assert.equal(selectReleaseAsset(version(5, 4, 4), PUBLISHED).asset.name, 'GeneralBlueprint-UE_5.4-Win64.zip');
  assert.equal(selectReleaseAsset(version(5, 4, 4), PUBLISHED).match, 'minor-line');
  assert.equal(selectReleaseAsset(version(5, 8, 0), PUBLISHED).asset.name, 'GeneralBlueprint-UE_5.8-Win64.zip');
  const exact = selectReleaseAsset(version(5, 8, 1), PUBLISHED);
  assert.equal(exact.asset.name, 'GeneralBlueprint-UE_5.8.1-Win64.zip');
  assert.equal(exact.match, 'exact-patch');
  assert.equal(selectReleaseAsset(version(5, 8, 2), PUBLISHED).ok, false);
  assert.match(selectReleaseAsset(version(5, 8, 2), PUBLISHED).reason, /5\.8\.2/);
  assert.equal(selectReleaseAsset(version(5, 9, 0), PUBLISHED).ok, false);
  const doubled = selectReleaseAsset(version(5, 8, 1), [PUBLISHED.at(-1), { ...PUBLISHED.at(-1), tag: 'v9' }]);
  assert.equal(doubled.ok, false);
});

test('BuildId comparison does not treat a changelist as a match', () => {
  const plugin = { buildId: OBSERVED_UE581.modulesBuildId, modules: {}, path: 'plugin' };
  const engine = { buildId: OBSERVED_UE581.validationChangelist, modules: {}, path: 'engine' };
  assert.equal(compareBuildIds(plugin, engine).status, 'mismatch');
  assert.equal(compareBuildIds(plugin, { ...engine, buildId: OBSERVED_UE581.modulesBuildId }).status, 'match');
  assert.equal(compareBuildIds(plugin, undefined).status, 'unverified');
  assert.match(compareBuildIds(plugin, undefined).note, /CompatibleChangelist/);
});

test('engine kind uses Unreal markers, not the path', () => {
  const root = mkdtempSync(join(tmpdir(), 'gb-kind-'));
  mkdirSync(join(root, 'Engine', 'Build'), { recursive: true });
  const none = classifyEngineKind(join(root, 'Epic Games', 'UE_5.4'), []);
  assert.equal(none.kind, 'ambiguous');
  writeFileSync(join(root, 'Engine', 'Build', 'InstalledBuild.txt'), '1');
  assert.equal(classifyEngineKind(root, []).kind, 'launcher');
  writeFileSync(join(root, 'Engine', 'Build', 'SourceDistribution.txt'), '');
  assert.equal(classifyEngineKind(root, []).kind, 'ambiguous');
  rmSync(join(root, 'Engine', 'Build', 'InstalledBuild.txt'));
  assert.equal(classifyEngineKind(root, []).kind, 'source');
  assert.equal(
    classifyEngineKind(root, [{ identifier: '5.4', root, via: 'launcher', sourceDistribution: false }]).kind,
    'ambiguous',
  );
});

test('archive extraction rejects path escape and links', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gb-zip-'));
  const good = join(root, 'good.zip');
  writeFileSync(good, makeZip([{ name: 'GeneralBlueprint/GeneralBlueprint.uplugin', data: Buffer.from('{"VersionName":"1"}') }]));
  const extracted = await extractPluginArchive(good, join(root, 'out'));
  assert.equal(readFileSync(join(extracted, 'GeneralBlueprint.uplugin'), 'utf8'), '{"VersionName":"1"}');

  await assert.rejects(
    extractPluginArchive(writeZip(root, 'slip.zip', [{ name: '../evil.txt', data: Buffer.from('x') }]), join(root, 'slip')),
    UnsafeArchiveError,
  );
  assert.equal(existsSync(join(root, 'evil.txt')), false);

  await assert.rejects(
    extractPluginArchive(
      writeZip(root, 'link.zip', [{ name: 'GeneralBlueprint/link', data: Buffer.from('target'), mode: 0o120777 }]),
      join(root, 'link'),
    ),
    /link entry/,
  );
});

test('UE 5.8 source staging merges MCP modules and older engines do not', () => {
  const root = mkdtempSync(join(tmpdir(), 'gb-stage-'));
  const checkout = join(root, 'src');
  writeCheckout(checkout);
  const older = join(root, 'older');
  stageSourceTree(checkout, older, version(5, 6, 1));
  const olderDescriptor = JSON.parse(readFileSync(join(older, 'GeneralBlueprint.uplugin'), 'utf8'));
  assert.deepEqual(olderDescriptor.Modules.map((item) => item.Name), ['BlueprintLisp']);
  assert.equal(existsSync(join(older, 'Source', 'BlueprintLispMCP')), false);

  const newer = join(root, 'newer');
  stageSourceTree(checkout, newer, version(5, 8, 1));
  const descriptor = JSON.parse(readFileSync(join(newer, 'GeneralBlueprint.uplugin'), 'utf8'));
  assert.ok(descriptor.Modules.some((item) => item.Name === 'BlueprintLispMCP'));
  assert.ok(descriptor.Plugins.some((item) => item.Name === 'ModelContextProtocol'));
  assert.equal(existsSync(join(newer, 'Source', 'BlueprintLispMCP', 'BlueprintLispMCP.Build.cs')), true);
});

test('launcher install copies the matching package and refuses a BuildId mismatch', async () => {
  const fixture = makeProject('launcher');
  const zip = pluginZip('55116800');
  const hash = sha256(zip);
  let downloads = 0;
  const running = await start(fixture, {
    fetchImpl: releaseFetch(hash, zip, () => {
      downloads += 1;
    }),
    fetchSource: async () => {
      throw new Error('source clone must not run for a launcher engine');
    },
  });
  try {
    const first = await running.setup.view();
    assert.equal(first.prompt.show, true);
    assert.equal(first.plan.assetName, 'GeneralBlueprint-UE_5.4-Win64.zip');
    assert.match(await page(running), /id="modal-install"/);
    assert.match(await page(running), /id="install-project"/);
    assert.equal(existsSync(join(fixture.project, 'Plugins', 'GeneralBlueprint', 'GeneralBlueprint.uplugin')), false);

    await running.setup.install({ target: 'project' });
    const done = await wait(running.setup);
    assert.equal(done.job.phase, 'done', done.job.error);
    assert.equal(downloads, 1);
    const manifest = readModuleManifest(join(fixture.project, 'Plugins', 'GeneralBlueprint', 'Binaries', 'Win64', 'UnrealEditor.modules'));
    assert.equal(manifest.buildId, '55116800');
    const uproject = JSON.parse(readFileSync(join(fixture.project, 'Demo.uproject'), 'utf8'));
    assert.equal(uproject.Plugins.find((item) => item.Name === 'ModelContextProtocol').Enabled, true);
    assert.equal(uproject.Plugins.find((item) => item.Name === 'GeneralBlueprint').Enabled, true);

    await assert.rejects(running.setup.install({ target: 'project' }), /already exists/);
    await assert.rejects(running.setup.install({ target: 'engine' }), /confirmEngineWrite/);
  } finally {
    await running.close();
  }

  const mismatch = makeProject('mismatch');
  const badZip = pluginZip('000');
  const bad = await start(mismatch, { fetchImpl: releaseFetch(sha256(badZip), badZip) });
  try {
    await bad.setup.install({ target: 'project' });
    const failed = await wait(bad.setup);
    assert.equal(failed.job.phase, 'failed');
    assert.match(failed.job.error, /BuildId/);
    assert.equal(existsSync(join(mismatch.project, 'Plugins', 'GeneralBlueprint', 'GeneralBlueprint.uplugin')), false);
  } finally {
    await bad.close();
  }
});

test('an unpublished engine version does not fall back to source', async () => {
  const fixture = makeProject('missing-release', { minor: 8, patch: 2 });
  let fetches = 0;
  const running = await start(fixture, {
    fetchImpl: releaseFetch('aa'.repeat(32), Buffer.from('unused'), () => {
      fetches += 1;
    }),
    fetchSource: async () => {
      throw new Error('must not clone');
    },
  });
  try {
    const view = await running.setup.view();
    assert.equal(view.plan.mode, 'none');
    assert.match(view.plan.reason, /5\.8\.2/);
    assert.equal(view.form.canInstall, false);
    await assert.rejects(running.setup.install({ target: 'project' }), /5\.8\.2/);
    assert.equal(fetches, 0);
  } finally {
    await running.close();
  }
});

test('source install compiles with the engine script and retries the build', async () => {
  const fixture = makeProject('source', { source: true, minor: 5, patch: 6 });
  let clones = 0;
  const running = await start(fixture, {
    fetchImpl: async () => {
      throw new Error('release download must not run');
    },
    fetchSource: async (dest) => {
      clones += 1;
      writeCheckout(dest);
    },
  });
  try {
    const preview = await running.setup.view();
    assert.equal(preview.plan.mode, 'source');
    assert.match(preview.plan.reason, /6c0d8e12aaad83ead5a39439a173cde58b240607/);
    writeFileSync(join(fixture.engine, 'Engine', 'Build', 'BatchFiles', 'Linux', 'fail'), '');
    await running.setup.install({ target: 'project' });
    const failed = await wait(running.setup);
    assert.equal(failed.job.phase, 'failed');
    assert.match(failed.job.logTail.join('\n'), /boom/);
    assert.equal(clones, 1);
    rmSync(join(fixture.engine, 'Engine', 'Build', 'BatchFiles', 'Linux', 'fail'));
    await running.setup.install({ target: 'project' });
    const done = await wait(running.setup);
    assert.equal(done.job.phase, 'done', done.job.error);
    assert.equal(clones, 1);
    const args = readFileSync(join(fixture.engine, 'Engine', 'Build', 'BatchFiles', 'Linux', 'last-args.txt'), 'utf8');
    assert.match(args, /UnrealEditor Linux Development/);
    assert.match(args, /Demo\.uproject/);
    assert.equal(existsSync(join(fixture.project, 'Plugins', 'GeneralBlueprint', 'Source', 'BlueprintLispMCP')), false);
  } finally {
    await running.close();
  }
});

test('ambiguous engines wait for an explicit kind, and engine writes are confirmed', async () => {
  const fixture = makeProject('ambiguous', { source: true, installed: true });
  const running = await start(fixture, {
    fetchSource: async (dest) => writeCheckout(dest),
    fetchImpl: async () => {
      throw new Error('no release');
    },
  });
  try {
    const view = await running.setup.view();
    assert.equal(view.engine.detectedKind, 'ambiguous');
    assert.equal(view.form.canInstall, false);
    assert.match(await page(running), /modal-choose-source/);
    await assert.rejects(running.setup.install({ target: 'project' }), /launcher install or a source build/);
    await running.setup.chooseKind('source');
    await running.setup.install({ target: 'engine', confirmEngineWrite: true });
    const done = await wait(running.setup);
    assert.equal(done.job.phase, 'done', done.job.error);
    assert.equal(existsSync(join(fixture.engine, 'Engine', 'Plugins', 'GeneralBlueprint', 'GeneralBlueprint.uplugin')), true);
    assert.equal(existsSync(join(fixture.project, 'Plugins', 'GeneralBlueprint', 'GeneralBlueprint.uplugin')), false);
  } finally {
    await running.close();
  }
});

test('an existing plugin is kept until replace is confirmed', async () => {
  const fixture = makeProject('owned');
  const plugin = join(fixture.project, 'Plugins', 'GeneralBlueprint');
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, 'GeneralBlueprint.uplugin'), '{"VersionName":"local","Note":"mine"}\n');
  writeFileSync(join(plugin, 'KEEP.txt'), 'user edit');
  const zip = pluginZip('55116800');
  const running = await start(fixture, { fetchImpl: releaseFetch(sha256(zip), zip) });
  try {
    await assert.rejects(running.setup.install({ target: 'project' }), /already exists/);
    assert.equal(readFileSync(join(plugin, 'KEEP.txt'), 'utf8'), 'user edit');
    await running.setup.install({ target: 'project', replace: true });
    const done = await wait(running.setup);
    assert.equal(done.job.phase, 'done', done.job.error);
    assert.equal(existsSync(join(plugin, 'KEEP.txt')), false);
    assert.equal(readFileSync(join(done.job.backupPath, 'KEEP.txt'), 'utf8'), 'user edit');
    assert.equal(done.job.backupPath.includes(`${fixture.project}/Plugins`), false);
  } finally {
    await running.close();
  }
});

test('a second install does not start while the first is running, and cancel stops it', async () => {
  const fixture = makeProject('cancel');
  let releaseDownload;
  const gate = new Promise((resolvePromise) => {
    releaseDownload = resolvePromise;
  });
  const running = await start(fixture, {
    fetchImpl: async (url, init) => {
      if (String(url).includes('/releases?')) return json(releasesBody(sha256(pluginZip('55116800'))));
      if (String(url).endsWith('SHA256SUMS.txt')) return text(`${sha256(pluginZip('55116800'))}  GeneralBlueprint-UE_5.4-Win64.zip\n`);
      await new Promise((resolvePromise, reject) => {
        const timer = setTimeout(resolvePromise, 5000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        });
      });
      releaseDownload();
      return new Response(pluginZip('55116800'));
    },
  });
  try {
    await running.setup.install({ target: 'project' });
    await assert.rejects(running.setup.install({ target: 'project' }), /already running/);
    running.setup.cancel();
    const view = await wait(running.setup);
    assert.equal(view.job.phase, 'cancelled');
    assert.equal(existsSync(join(fixture.project, 'Plugins', 'GeneralBlueprint', 'GeneralBlueprint.uplugin')), false);
  } finally {
    releaseDownload();
    await running.close();
  }
});

function makeProject(name, options = {}) {
  const root = mkdtempSync(join(tmpdir(), `gb-${name}-`));
  const engine = join(root, 'engine');
  const project = join(root, 'project');
  const minor = options.minor ?? 4;
  const patch = options.patch ?? 4;
  mkdirSync(join(engine, 'Engine', 'Binaries', 'Win64'), { recursive: true });
  mkdirSync(join(engine, 'Engine', 'Build', 'BatchFiles', 'Linux'), { recursive: true });
  writeFileSync(join(engine, 'Engine', 'Build', 'BatchFiles', 'Build.bat'), '@echo off\r\n');
  writeFileSync(
    join(engine, 'Engine', 'Build', 'BatchFiles', 'Linux', 'Build.sh'),
    '#!/bin/sh\necho "$@" >> "$(dirname "$0")/last-args.txt"\nif [ -f "$(dirname "$0")/fail" ]; then echo boom >&2; exit 1; fi\necho compile-ok\nexit 0\n',
  );
  chmodSync(join(engine, 'Engine', 'Build', 'BatchFiles', 'Linux', 'Build.sh'), 0o755);
  writeFileSync(
    join(engine, 'Engine', 'Build', 'Build.version'),
    JSON.stringify({
      MajorVersion: 5,
      MinorVersion: minor,
      PatchVersion: patch,
      Changelist: 56057345,
      CompatibleChangelist: 55116800,
      BranchName: '++UE5+Release-test',
    }),
  );
  writeFileSync(
    join(engine, 'Engine', 'Binaries', 'Win64', 'UnrealEditor.modules'),
    JSON.stringify({ BuildId: '55116800', Modules: {} }),
  );
  if (options.source) writeFileSync(join(engine, 'Engine', 'Build', 'SourceDistribution.txt'), '');
  if (options.installed || !options.source) writeFileSync(join(engine, 'Engine', 'Build', 'InstalledBuild.txt'), '1');
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, 'Demo.uproject'),
    JSON.stringify({ FileVersion: 3, EngineAssociation: '', Plugins: [{ Name: 'ModelContextProtocol', Enabled: true }] }, null, 2),
  );
  return { root, engine, project };
}

async function start(fixture, extras) {
  const running = await startPluginSetup({
    projectRoot: fixture.project,
    engineRoot: fixture.engine,
    statePath: join(fixture.root, 'state.json'),
    selectionPath: join(fixture.root, 'selection.json'),
    backupRoot: join(fixture.root, 'backups'),
    logRoot: join(fixture.root, 'logs'),
    autoOpen: false,
    listEngines: async () => [],
    ...extras,
  });
  return running;
}

function pluginZip(buildId) {
  return makeZip([
    {
      name: 'GeneralBlueprint/GeneralBlueprint.uplugin',
      data: Buffer.from(JSON.stringify({ VersionName: '1.0.0-beta.1', FriendlyName: 'GeneralBlueprint', Modules: [] })),
    },
    {
      name: 'GeneralBlueprint/Binaries/Win64/UnrealEditor.modules',
      data: Buffer.from(JSON.stringify({ BuildId: buildId, Modules: { BlueprintLisp: 'UnrealEditor-BlueprintLisp.dll' } })),
    },
  ]);
}

function writeCheckout(dest) {
  mkdirSync(join(dest, 'Source', 'BlueprintLisp'), { recursive: true });
  mkdirSync(join(dest, 'MCP', 'Source', 'BlueprintLispMCP'), { recursive: true });
  writeFileSync(
    join(dest, 'GeneralBlueprint.uplugin'),
    JSON.stringify({ VersionName: '1.1.0-beta.1', Modules: [{ Name: 'BlueprintLisp' }], Plugins: [] }),
  );
  writeFileSync(join(dest, 'Source', 'BlueprintLisp', 'BlueprintLisp.Build.cs'), 'class X {}');
  writeFileSync(
    join(dest, 'MCP', 'GeneralBlueprintMCP.uplugin'),
    JSON.stringify({
      Modules: [{ Name: 'BlueprintLispMCP', Type: 'Editor', LoadingPhase: 'Default' }],
      Plugins: [
        { Name: 'GeneralBlueprint', Enabled: true },
        { Name: 'ModelContextProtocol', Enabled: true },
      ],
    }),
  );
  writeFileSync(join(dest, 'MCP', 'Source', 'BlueprintLispMCP', 'BlueprintLispMCP.Build.cs'), 'class Y {}');
}

function releasesBody(hash) {
  return [
    {
      tag_name: 'v1.0.0-beta.1',
      assets: [
        ...['4.26', '5.4', '5.8'].map((label) => ({
          name: `GeneralBlueprint-UE_${label}-Win64.zip`,
          digest: label === '5.4' ? `sha256:${hash}` : `sha256:${'11'.repeat(32)}`,
          browser_download_url: `https://github.com/cc8887/GeneralBlueprint/releases/download/v1.0.0-beta.1/GeneralBlueprint-UE_${label}-Win64.zip`,
        })),
        {
          name: 'SHA256SUMS.txt',
          browser_download_url: 'https://github.com/cc8887/GeneralBlueprint/releases/download/v1.0.0-beta.1/SHA256SUMS.txt',
        },
      ],
    },
    {
      tag_name: 'v1.1.0-beta.1',
      assets: [
        {
          name: 'GeneralBlueprint-UE_5.8.1-Win64.zip',
          digest: `sha256:${'22'.repeat(32)}`,
          browser_download_url: 'https://github.com/cc8887/GeneralBlueprint/releases/download/v1.1.0-beta.1/GeneralBlueprint-UE_5.8.1-Win64.zip',
        },
      ],
    },
  ];
}

function releaseFetch(hash, zip, onDownload) {
  return async (url) => {
    const href = String(url);
    if (href.includes('/releases?')) return json(releasesBody(hash));
    if (href.endsWith('SHA256SUMS.txt')) return text(`${hash}  GeneralBlueprint-UE_5.4-Win64.zip\n${'11'.repeat(32)}  GeneralBlueprint-UE_4.26-Win64.zip\n${'11'.repeat(32)}  GeneralBlueprint-UE_5.8-Win64.zip\n`);
    if (href.includes('/releases/download/')) {
      onDownload?.();
      return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/generalblueprint.zip' } });
    }
    if (href.includes('release-assets.githubusercontent.com')) return new Response(zip);
    throw new Error(`unexpected fetch ${href}`);
  };
}

function json(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function text(body) {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
}

async function page(running) {
  const response = await fetch(running.url);
  return response.text();
}

async function wait(setup) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const view = await setup.view();
    if (view.job && view.job.phase !== 'running') return view;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`install did not finish: ${JSON.stringify((await setup.view()).job)}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeZip(root, name, entries) {
  const path = join(root, name);
  writeFileSync(path, makeZip(entries));
  return path;
}

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const stored = entry.data;
    const compressed = deflateRawSync(stored);
    const crc = crc32(stored) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(stored.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localBuf = Buffer.concat([local, name, compressed]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.mode ? 0x0314 : 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(stored.length, 24);
    central.writeUInt16LE(name.length, 28);
    if (entry.mode) central.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(localBuf);
    centrals.push(Buffer.concat([central, name]));
    offset += localBuf.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}
