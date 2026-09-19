/** List what the running editor actually exposes right now. */
const res = await fetch('http://127.0.0.1:8000/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } }),
});
const sid = res.headers.get('mcp-session-id');
await res.text();

const list = await fetch('http://127.0.0.1:8000/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) },
  body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
});
const body = await list.text();
const data = JSON.parse(body.replace(/^data:\s*/m, ''));
const tools = data.result?.tools ?? [];
console.log(`tools: ${tools.length}\n`);
for (const t of tools) console.log(`- ${t.name}`);
const exec = tools.filter((t) => /python|exec|console|command/i.test(t.name));
console.log(`\nexec-ish: ${exec.map((t) => t.name).join(', ') || '(none)'}`);
