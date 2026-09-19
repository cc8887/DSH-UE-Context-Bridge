/**
 * smoke.ts — real end-to-end smoke against the live editor.
 *
 * Connects, indexes, searches, then invokes one discovered read-only tool.
 */

import { UeMcpClient } from './upstream-mcp/client.ts';

const URL_ = 'http://127.0.0.1:8000/mcp';

async function main(): Promise<void> {
  const client = new UeMcpClient();
  await client.connect({ mcp_entry: { transport: 'http', url: URL_ } });
  const tools = await client.listTools();
  console.error(`indexed ${tools.length} tools`);

  const target = process.argv[2] ?? 'ToolsetRegistry.AgentSkillToolset.ListSkills';
  const found = tools.find((t) => t.name === target);
  if (!found) {
    console.error(`tool not found: ${target}`);
    console.error('available:', tools.map((t) => t.name).join(', '));
    process.exit(2);
  }
  console.error(`schema: ${JSON.stringify(found.inputSchema)}`);

  const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  const result = await client.callTool({ name: target, args });
  console.error(`RESULT ${JSON.stringify(result).slice(0, 1200)}`);

  await client.close();
}

main().catch((e) => {
  console.error('smoke failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
