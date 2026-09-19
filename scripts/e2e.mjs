/**
 * e2e.mjs — full gateway end-to-end against the live editor.
 *
 * Drives the real JSON-lines IPC: connect, search, describe, invoke.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = 'http://127.0.0.1:8000/mcp';

const child = spawn(process.execPath, ['--experimental-strip-types', join(root, 'packages/gateway/src/main.ts')], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
const pending = new Map();
let seq = 0;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let i = buffer.indexOf('\n');
  while (i >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) {
      const res = JSON.parse(line);
      const p = pending.get(res.id);
      if (p) {
        pending.delete(res.id);
        p(res);
      }
    }
    i = buffer.indexOf('\n');
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => process.stderr.write(`[gw] ${c}`));

function call(method, params) {
  seq += 1;
  const id = String(seq);
  const req = {
    jsonrpc: '2.0',
    id,
    method,
    params,
    identity: { session_id: 's1', project_id: 'p1', editor_epoch: 'e1', host_call_id: `h${id}` },
  };
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify(req)}\n`);
  });
}

const connect = await call('gateway.connect', { mcp_entry: { transport: 'http', url: URL_ } });
console.log('CONNECT', JSON.stringify(connect.result ?? connect.error));

const health = await call('gateway.health', {});
console.log('HEALTH', JSON.stringify(health.result));

const search = await call('catalog.search', { query: 'crash', detail: 'summary', limit: 5 });
const hits = search.result?.hits ?? [];
console.log(`SEARCH hits=${hits.length} coverage=${search.result?.coverage}`);
for (const h of hits) console.log(`   - ${h.id}`);

if (hits.length > 0) {
  // GetRecentCrashes takes an optional arg, so it exercises the success path.
  const toolId = 'CrashDiagnosticsToolset.CrashDiagnosticsToolset.GetRecentCrashes';
  const desc = await call('catalog.describe', { tool_id: toolId });
  console.log(`DESCRIBE ${toolId} rev=${desc.result?.schemaRevision ?? JSON.stringify(desc.error)}`);

  const invoke = await call('invocation.execute', {
    tool_id: toolId,
    schema_revision: desc.result.schemaRevision,
    arguments: { numberToRetrieve: 2 },
    effect_class: 'verified_read',
  });
  const r = invoke.result ?? invoke.error;
  console.log('INVOKE', JSON.stringify(r).slice(0, 500));
  if (invoke.result) {
    console.log('execution=', invoke.result.execution, 'truncated=', invoke.result.truncated);
  }
}

child.kill();
