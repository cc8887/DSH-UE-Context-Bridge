/**
 * py-probe.mjs — invoke the registered Python tool in the live editor.
 *
 * Verifies the python bridge executes and returns output, and that a failing
 * program reports an error instead of crashing the editor.
 */

const U = 'http://127.0.0.1:8000/mcp';
const TOOL = 'dsh_python_bridge_toolset.python_bridge.DshPythonTools.execute_python';

async function rpc(body, sid) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (sid) h['Mcp-Session-Id'] = sid;
  const r = await fetch(U, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const s = r.headers.get('mcp-session-id') || sid;
  const t = await r.text();
  const l = t.split('\n').find((x) => x.startsWith('data:'));
  try {
    return { j: JSON.parse(l ? l.slice(5) : t), s };
  } catch {
    return { j: t, s };
  }
}

async function run(label, code) {
  const a = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'p', version: '1' } },
  });
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, a.s);
  const { j } = await rpc(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: TOOL, arguments: { code, description: label } },
    },
    a.s,
  );
  console.log(`--- ${label} ---`);
  console.log(JSON.stringify(j).slice(0, 800));
}

const ok = [
  'import unreal',
  'print("hello from editor")',
  'unreal.log("py bridge ok")',
  '_result = 6 * 7',
].join('\n');

const bad = ['raise ValueError("boom from probe")'].join('\n');

await run('ok: print and compute', ok);
await run('error: raise', bad);
