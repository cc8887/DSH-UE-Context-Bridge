/**
 * Loopback setup UI.
 *
 * DSH's web client can host panels (`shell.overlay`, `main`, settings), but a
 * client plugin that fails to load blocks the whole Web UI, and this package
 * does not depend on the client slot runtime. The host therefore serves this
 * page itself and opens it when the plugin is missing. The page is the setup
 * UI: model tools are not given an install action.
 */

import { createServer, type Server } from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { PluginSetup, SetupError, type PluginSetupOptions } from './service.ts';
import { renderPage, renderPanel } from './page.ts';

export interface SetupServerOptions extends PluginSetupOptions {
  host?: string;
  port?: number;
  autoOpen?: boolean;
  openBrowser?: (url: string) => void;
  logger?: (line: string) => void;
}

export interface RunningSetup {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
  setup: PluginSetup;
}

export async function startPluginSetup(options: SetupServerOptions): Promise<RunningSetup> {
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('plugin setup UI binds to loopback only');
  }
  const token = randomBytes(24).toString('hex');
  const setup = new PluginSetup(options);
  const server = createServer((req, res) => {
    void handle(req, res, setup, token).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof SetupError ? error.status : 500;
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(message);
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('setup UI failed to bind');
  const url = `http://127.0.0.1:${address.port}/?token=${token}`;
  const running: RunningSetup = {
    url,
    port: address.port,
    token,
    setup,
    close: () => closeServer(server),
  };
  const view = await setup.view();
  if (options.autoOpen && view.prompt.show) {
    const open = options.openBrowser ?? openSystemBrowser;
    try {
      open(url);
    } catch (error) {
      options.logger?.(`GeneralBlueprint setup UI did not open: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  options.logger?.(`GeneralBlueprint setup UI: ${url}`);
  return running;
}

export function defaultSetupPaths(selectionFile: string): Pick<PluginSetupOptions, 'statePath' | 'backupRoot' | 'logRoot' | 'selectionPath'> {
  const base = dirname(selectionFile);
  return {
    selectionPath: selectionFile,
    statePath: join(base, 'generalblueprint-setup.json'),
    backupRoot: join(base, 'generalblueprint-backups'),
    logRoot: join(base, 'generalblueprint-logs'),
  };
}

export function defaultSelectionFile(): string {
  const home = process.env.USERPROFILE ?? homedir();
  return join(home, '.dsh', 'ue-bridge', 'engine-selection.json');
}

async function handle(
  req: { method?: string; url?: string; headers: NodeJS.Dict<string | string[] | undefined> },
  res: { writeHead(code: number, headers?: Record<string, string>): void; end(body?: string): void },
  setup: PluginSetup,
  token: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (!authorized(req.headers, url, token)) {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('setup token required');
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = renderPage(await setup.view(), token);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    });
    res.end(html);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/panel') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(renderPanel(await setup.view()));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(await setup.view()));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  const body = await readJson(req as never);
  if (url.pathname === '/api/project') {
    if (typeof body.projectRoot !== 'string' || body.projectRoot.trim() === '') throw new SetupError('projectRoot is required');
    await setup.setProject(body.projectRoot.trim());
  } else if (url.pathname === '/api/engine') {
    if (typeof body.choice !== 'string') throw new SetupError('choice is required');
    await setup.selectEngine(body.choice);
  } else if (url.pathname === '/api/kind') {
    if (body.kind !== 'launcher' && body.kind !== 'source') throw new SetupError('kind must be launcher or source');
    await setup.chooseKind(body.kind);
  } else if (url.pathname === '/api/dismiss') {
    await setup.dismiss();
  } else if (url.pathname === '/api/cancel') {
    setup.cancel();
  } else if (url.pathname === '/api/install') {
    if (body.target !== 'project' && body.target !== 'engine') throw new SetupError('target must be project or engine');
    await setup.install({
      target: body.target,
      ...(body.replace === true ? { replace: true } : {}),
      ...(body.confirmEngineWrite === true ? { confirmEngineWrite: true } : {}),
      ...(body.allowUnverifiedBuildId === true ? { allowUnverifiedBuildId: true } : {}),
    });
  } else {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(renderPanel(await setup.view()));
}

function authorized(headers: NodeJS.Dict<string | string[] | undefined>, url: URL, token: string): boolean {
  const header = headers['x-ue-bridge-token'];
  const presented = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get('token') ?? '';
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readJson(req: { on(event: string, listener: (chunk?: Buffer) => void): void }): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk?: Buffer) => {
      if (!chunk) return;
      size += chunk.length;
      if (size > 65_536) reject(new SetupError('body too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      } catch {
        reject(new SetupError('body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function openSystemBrowser(url: string): void {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/d', '/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}
