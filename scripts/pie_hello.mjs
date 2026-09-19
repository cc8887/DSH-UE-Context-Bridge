/**
 * Requirement 2: start a real PIE session and prove Hello World ran at its start.
 *
 * RunConsoleCommand only echoes ("Cmd:" in the log, no effect), so PIE is
 * started through EditorToolset.EditorAppToolset.StartPIE, which is the
 * editor's own tool for it. Evidence is gathered two ways: the BeginPlay log
 * line from ALyraHUD, and a viewport capture while the banner is on screen.
 */
const URL = 'http://127.0.0.1:8000/mcp';
const init = await fetch(URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-pie', version: '0' } } }),
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
async function call(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.error) return { error: r.error };
  return { text: r.result?.content?.map((c) => c.text).join('') ?? '' };
}
async function logLines(category, count = 600) {
  const r = await call('ConsoleToolset.LogsToolset.GetLogEntries', { category, count });
  try { return JSON.parse(r.text).returnValue ?? []; } catch { return []; }
}

const MARK = 'LyraHUD BeginPlay: Hello World';
const before = (await logLines('LogTemp')).filter((l) => l.includes(MARK)).length;
console.log(`baseline: ${before} Hello World lines`);

console.log('\n--- StartPIE ---');
console.log(JSON.stringify(await call('EditorToolset.EditorAppToolset.StartPIE', {
  options: { bSimulate: false, playMode: 'PlayMode_InViewPort' },
})).slice(0, 400));

// Let the map load and BeginPlay run.
await new Promise((r) => setTimeout(r, 15000));

const running = await call('EditorToolset.EditorAppToolset.IsPIERunning');
console.log(`IsPIERunning: ${running.text ?? JSON.stringify(running)}`);

const after = (await logLines('LogTemp')).filter((l) => l.includes(MARK));
console.log(`\nHello World lines after PIE: ${after.length}`);
for (const l of after.slice(-3)) console.log(`  ${l}`);

console.log('\n--- capture viewport ---');
const shot = await call('EditorToolset.EditorAppToolset.CaptureViewport');
console.log(String(shot.text ?? JSON.stringify(shot)).slice(0, 300));

console.log('\n--- StopPIE ---');
console.log(JSON.stringify(await call('EditorToolset.EditorAppToolset.StopPIE')).slice(0, 300));

console.log(after.length > before ? '\nPASS: PIE started and Hello World ran at BeginPlay' : '\nFAIL: PIE did not produce Hello World');
