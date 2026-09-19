/**
 * Prove the "hello world" really reached the editor's log.
 *
 * RunConsoleCommand returned only {"returnValue":["Cmd"]}, which is an
 * acknowledgement, not evidence. So search the editor's own log entries for
 * the text, and compare against a baseline taken before the command.
 */
const URL = 'http://127.0.0.1:8000/mcp';
const init = await fetch(URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-hello2', version: '0' } } }),
});
const sid = init.headers.get('mcp-session-id');
await init.text();
let id = 10;
async function rpc(method, params) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': sid },
    body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }),
  });
  return JSON.parse((await r.text()).replace(/^data:\s*/m, ''));
}
async function entries(category, count = 400) {
  const r = await rpc('tools/call', { name: 'ConsoleToolset.LogsToolset.GetLogEntries', arguments: { category, count } });
  const txt = r.result?.content?.[0]?.text;
  if (!txt) return [];
  try { return JSON.parse(txt).returnValue ?? []; } catch { return []; }
}

const MARK = 'dsh_hello_world_marker_9182';
const before = (await entries('LogConsoleResponse')).filter((l) => l.includes(MARK)).length;

const call = await rpc('tools/call', {
  name: 'ConsoleToolset.ConsoleToolset.RunConsoleCommand',
  arguments: { command: `Log ${MARK} hello world` },
});
console.log('call ok:', JSON.stringify(call.result?.content?.[0]?.text ?? call.error));

await new Promise((r) => setTimeout(r, 1500));

const after = (await entries('LogConsoleResponse')).filter((l) => l.includes(MARK));
console.log(`\nbefore: ${before} matching lines`);
console.log(`after : ${after.length} matching lines`);
for (const line of after) console.log(`  ${line}`);

if (after.length > before) {
  console.log('\nPASS: the editor logged the text; MCP -> editor path is real');
} else {
  console.log('\nINCONCLUSIVE: command returned but text not found in LogConsoleResponse');
  const any = (await entries('')).filter((l) => l.includes(MARK));
  console.log(`matches in unfiltered log: ${any.length}`);
  for (const line of any.slice(0, 5)) console.log(`  ${line}`);
}
