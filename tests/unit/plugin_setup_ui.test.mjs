/**
 * Drives the setup page in headless Chrome. The install button is on screen,
 * and the plugin directory stays empty until that button is clicked.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { startPluginSetup } from '../../packages/dsh-plugin/src/plugin-setup/server.ts';

const ARTIFACTS = '/opt/cursor/artifacts';

test('setup page shows an install button and installs only after the click', async () => {
  const fixture = makeLauncher();
  const zip = pluginZip('55116800');
  const hash = createHash('sha256').update(zip).digest('hex');
  const running = await startPluginSetup({
    projectRoot: fixture.project,
    engineRoot: fixture.engine,
    statePath: join(fixture.root, 'state.json'),
    selectionPath: join(fixture.root, 'selection.json'),
    backupRoot: join(fixture.root, 'backups'),
    logRoot: join(fixture.root, 'logs'),
    autoOpen: false,
    listEngines: async () => [],
    fetchImpl: releaseFetch(hash, zip),
  });
  const chrome = await launchChrome();
  try {
    const session = await connect(chrome.port);
    await session.navigate(running.url);
    const before = await session.evaluate(`({
      modal: Boolean(document.getElementById('setup-modal')),
      label: document.getElementById('modal-install') ? document.getElementById('modal-install').textContent : ''
    })`);
    assert.equal(before.modal, true);
    assert.match(before.label, /安装发布包/);
    assert.equal(existsSync(join(fixture.project, 'Plugins', 'GeneralBlueprint', 'GeneralBlueprint.uplugin')), false);
    mkdirSync(ARTIFACTS, { recursive: true });
    await session.screenshot(join(ARTIFACTS, 'plugin-setup-missing.png'));
    await session.evaluate(`document.getElementById('modal-install').click()`);
    await session.waitFor(async () => (await session.evaluate('document.body.innerText')).includes('已安装'));
    assert.equal(existsSync(join(fixture.project, 'Plugins', 'GeneralBlueprint', 'GeneralBlueprint.uplugin')), true);
    await session.screenshot(join(ARTIFACTS, 'plugin-setup-installed.png'));
  } finally {
    chrome.close();
    await running.close();
  }
});

function releaseFetch(hash, zip) {
  return async (url) => {
    const href = String(url);
    if (href.includes('/releases?')) {
      return Response.json([
        {
          tag_name: 'v1.0.0-beta.1',
          assets: [
            {
              name: 'GeneralBlueprint-UE_5.4-Win64.zip',
              digest: `sha256:${hash}`,
              browser_download_url: 'https://github.com/cc8887/GeneralBlueprint/releases/download/v1.0.0-beta.1/GeneralBlueprint-UE_5.4-Win64.zip',
            },
            {
              name: 'SHA256SUMS.txt',
              browser_download_url: 'https://github.com/cc8887/GeneralBlueprint/releases/download/v1.0.0-beta.1/SHA256SUMS.txt',
            },
          ],
        },
      ]);
    }
    if (href.endsWith('SHA256SUMS.txt')) return new Response(`${hash}  GeneralBlueprint-UE_5.4-Win64.zip\n`);
    if (href.includes('/releases/download/')) {
      return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/generalblueprint.zip' } });
    }
    return new Response(zip);
  };
}

function makeLauncher() {
  const root = mkdtempSync(join(tmpdir(), 'gb-ui-'));
  const engine = join(root, 'engine');
  const project = join(root, 'project');
  mkdirSync(join(engine, 'Engine', 'Binaries', 'Win64'), { recursive: true });
  mkdirSync(join(engine, 'Engine', 'Build', 'BatchFiles'), { recursive: true });
  writeFileSync(join(engine, 'Engine', 'Build', 'BatchFiles', 'Build.bat'), '@echo off\r\n');
  writeFileSync(join(engine, 'Engine', 'Build', 'InstalledBuild.txt'), '1');
  writeFileSync(
    join(engine, 'Engine', 'Build', 'Build.version'),
    JSON.stringify({ MajorVersion: 5, MinorVersion: 4, PatchVersion: 4, Changelist: 1, CompatibleChangelist: 2 }),
  );
  writeFileSync(
    join(engine, 'Engine', 'Binaries', 'Win64', 'UnrealEditor.modules'),
    JSON.stringify({ BuildId: '55116800', Modules: {} }),
  );
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'Demo.uproject'), JSON.stringify({ FileVersion: 3, EngineAssociation: '', Plugins: [] }));
  return { root, engine, project };
}

function pluginZip(buildId) {
  const entries = [
    {
      name: 'GeneralBlueprint/GeneralBlueprint.uplugin',
      data: Buffer.from('{"VersionName":"1.0.0-beta.1","FriendlyName":"GeneralBlueprint"}'),
    },
    {
      name: 'GeneralBlueprint/Binaries/Win64/UnrealEditor.modules',
      data: Buffer.from(JSON.stringify({ BuildId: buildId, Modules: {} })),
    },
  ];
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localBuf = Buffer.concat([local, name, compressed]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
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

function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'gb-chrome-'));
  const child = spawn(
    'google-chrome',
    ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`chrome did not listen\n${output}`)), 15000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output);
      if (!match) return;
      clearTimeout(timer);
      resolvePromise({
        port: Number(match[1]),
        close: () => child.kill('SIGKILL'),
      });
    };
    child.stderr.on('data', onData);
    child.stdout.on('data', onData);
    child.on('error', reject);
  });
}

async function connect(port) {
  const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  const target = await created.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolvePromise, reject) => {
    ws.addEventListener('open', resolvePromise, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let next = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolvePromise, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolvePromise(message.result);
  });
  function send(method, params) {
    const id = next;
    next += 1;
    return new Promise((resolvePromise, reject) => {
      pending.set(id, { resolvePromise, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  return {
    async navigate(targetUrl) {
      await send('Page.enable');
      await send('Page.navigate', { url: targetUrl });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    },
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    },
    async screenshot(path) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path, Buffer.from(shot.data, 'base64'));
    },
    async waitFor(predicate) {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (await predicate()) return;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      throw new Error(`UI did not reach the expected state: ${await this.evaluate('document.body.innerText')}`);
    },
  };
}
