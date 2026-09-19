/**
 * Screenshot the editor window, not whatever happens to be on top.
 *
 * The previous attempt captured the foreground window, which was an IM client,
 * because SetForegroundWindow is only advisory. This instead locates the
 * editor window by handle and captures its rectangle, so the image is the
 * editor even when it is not the topmost window.
 *
 * Paths are derived from this file's location so the script runs from any
 * clone; the earlier hardcoded absolute path only worked on one machine.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const URL = 'http://127.0.0.1:8000/mcp';
const init = await fetch(URL, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ps', version: '0' } } }),
});
const sid = init.headers.get('mcp-session-id');
await init.text();
let id = 10;
async function call(name, args = {}) {
  const r = await fetch(URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': sid },
    body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const d = JSON.parse((await r.text()).replace(/^data:\s*/m, ''));
  if (d.error) return { text: JSON.stringify(d.error) };
  return { text: d.result?.content?.map((c) => c.text).join('') ?? '' };
}

console.log('StartPIE:', (await call('EditorToolset.EditorAppToolset.StartPIE', { options: { bSimulate: false, playMode: 'PlayMode_InViewPort' } })).text);
// The banner lives for HelloWorldDuration (8s), so capture inside that
// window; waiting longer would photograph the screen after it has faded.
await new Promise((r) => setTimeout(r, 6000));
console.log('IsPIERunning:', (await call('EditorToolset.EditorAppToolset.IsPIERunning')).text);

console.log(execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(REPO_ROOT, 'scripts', 'capture_screen.ps1')], { encoding: 'utf8' }).trim());

const out = path.join(REPO_ROOT, 'pie_hello.png');
console.log(existsSync(out) ? `PNG ${statSync(out).size} bytes` : 'PNG missing');

console.log('StopPIE:', (await call('EditorToolset.EditorAppToolset.StopPIE')).text);
