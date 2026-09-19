/**
 * raw-call.ts — invoke a UE MCP tool with a raw JSON-RPC request.
 *
 * Needed because the UE server declares an output schema but does not return
 * structured content, which makes the MCP SDK's client-side validation reject
 * otherwise successful calls. We send tools/call directly and read the raw
 * result.
 */

const URL_ = 'http://127.0.0.1:8000/mcp';

export interface RawCallResult {
  ok: boolean;
  body: unknown;
  sessionId?: string;
}

async function rpc(
  body: unknown,
  sessionId?: string,
): Promise<{ status: number; json: unknown; sessionId?: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const res = await fetch(URL_, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = res.headers.get('mcp-session-id') ?? sessionId;
  const text = await res.text();

  // Streamable HTTP may answer as SSE; unwrap the data: payload.
  let json: unknown = text;
  const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
  if (dataLine) {
    try {
      json = JSON.parse(dataLine.slice(5).trim());
    } catch {
      /* keep raw text */
    }
  } else if (text.trim().startsWith('{')) {
    try {
      json = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
  }
  return { status: res.status, json, sessionId: sid };
}

export async function rawCallTool(
  name: string,
  args: Record<string, unknown>,
): Promise<RawCallResult> {
  const init = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-ue-context-bridge', version: '0.1.0' },
    },
  });
  const sid = init.sessionId;
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid);

  const called = await rpc(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
    sid,
  );
  return { ok: called.status < 400, body: called.json, sessionId: sid };
}

async function main(): Promise<void> {
  const name = process.env.UE_TOOL ?? process.argv[2];
  if (!name) {
    console.error('usage: UE_TOOL=<name> UE_ARGS=<json> node raw-call.ts');
    process.exit(2);
  }
  const args = process.env.UE_ARGS ? JSON.parse(process.env.UE_ARGS) : {};
  const result = await rawCallTool(name, args);
  console.error(JSON.stringify(result.body, null, 2).slice(0, 2000));
}

main().catch((e) => {
  console.error('raw call failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
