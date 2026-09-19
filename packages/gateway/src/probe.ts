/**
 * probe.ts — P0 contract probe: connect to the live editor and record the real
 * tools/list response.
 *
 * Run against a running editor:
 *   node --experimental-strip-types packages/gateway/src/probe.ts
 */

import { UeMcpClient } from './upstream-mcp/client.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const URL_ = 'http://127.0.0.1:8000/mcp';

async function main(): Promise<void> {
  const client = new UeMcpClient();
  const result = await client.connect({ mcp_entry: { transport: 'http', url: URL_ } });
  console.error('connected:', JSON.stringify(result, null, 2));

  const health = await client.health();
  console.error('health:', JSON.stringify(health));

  const tools = await client.listTools();
  console.error(`tools: ${tools.length}`);
  for (const t of tools) console.error(`  - ${t.name}`);

  const outDir = join(process.cwd(), 'fixtures', 'contracts', 'ue6-main');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, '02-tools-list.json'),
    JSON.stringify({ endpoint: URL_, captured_at: new Date().toISOString(), tools }, null, 2),
    'utf8',
  );
  console.error(`wrote ${join(outDir, '02-tools-list.json')}`);

  await client.close();
}

main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});
