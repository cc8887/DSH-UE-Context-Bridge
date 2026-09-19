/**
 * client.ts — real UE MCP client over Streamable HTTP.
 *
 * Uses raw JSON-RPC rather than the MCP SDK client: the UE server declares an
 * output schema for some tools but returns only text content, which the SDK's
 * structured-content validation rejects even for successful calls.
 *
 * The endpoint is read from the editor-generated config, never hardcoded.
 * With `bEnableToolSearch=False` the editor exposes the COMPLETE tool list, so
 * a full per-tool index is built from one `tools/list` — no guessing, and no
 * reliance on meta-tool dispatch.
 */

import type { ConnectParams, ConnectResult, HealthResult } from '@ue-bridge/contracts/ipc';

export interface McpToolEntry {
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
}

export interface UpstreamMcp {
  connect(params: ConnectParams): Promise<ConnectResult>;
  health(): Promise<HealthResult>;
  listTools(): Promise<McpToolEntry[]>;
  callTool(input: { name: string; args: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export class UeMcpClient implements UpstreamMcp {
  private endpoint = '';
  private sessionId: string | undefined;
  private seq = 0;

  async connect(params: ConnectParams): Promise<ConnectResult> {
    const entry = params.mcp_entry;
    if (!entry?.url) {
      throw new Error('mcp_entry.url is required; read it from the editor-generated config');
    }
    this.endpoint = entry.url;

    const init = await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-ue-context-bridge', version: '0.1.0' },
    });
    if (init.error) throw new Error(`initialize failed: ${init.error.message}`);

    await this.notify('notifications/initialized');

    const result = init.result ?? {};
    const serverInfo = result.serverInfo as { name?: string; version?: string } | undefined;
    return {
      protocol: this.endpoint,
      capabilities: Object.keys((result.capabilities as Record<string, unknown>) ?? {}),
      engine_build: serverInfo?.name
        ? `${serverInfo.name} ${serverInfo.version ?? ''}`.trim()
        : 'unknown',
      editor_epoch: new Date().toISOString(),
    };
  }

  /** A live round-trip, never a cached catalog: a stale index is not proof of life. */
  async health(): Promise<HealthResult> {
    if (!this.endpoint) return { online: false, verified_by_realtime_probe: false };
    try {
      await this.listTools();
      return { online: true, verified_by_realtime_probe: true };
    } catch {
      return { online: false, verified_by_realtime_probe: false };
    }
  }

  async listTools(): Promise<McpToolEntry[]> {
    const res = await this.rpc('tools/list', {});
    if (res.error) throw new Error(`tools/list failed: ${res.error.message}`);
    const tools = (res.result?.tools ?? []) as Array<Record<string, unknown>>;
    return tools.map((t) => ({
      name: String(t.name),
      ...(typeof t.description === 'string' ? { description: t.description } : {}),
      inputSchema: t.inputSchema,
      ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
    }));
  }

  async callTool(input: { name: string; args: Record<string, unknown> }): Promise<unknown> {
    const res = await this.rpc('tools/call', { name: input.name, arguments: input.args });

    // Transport success is not business success: an MCP error object must
    // surface as a failure, not as a successful empty payload.
    if (res.error) throw new Error(res.error.message);
    const result = res.result ?? {};
    if (result.isError === true) {
      throw new Error(extractText(result) || 'tool returned an error result');
    }
    if (result.structuredContent !== undefined) return result.structuredContent;

    const text = extractText(result);
    // UE returns JSON payloads as text content; parse when possible so the
    // caller gets a structured value rather than an opaque string.
    if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  }

  async close(): Promise<void> {
    this.sessionId = undefined;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    this.seq += 1;
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', id: this.seq, method, params }),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    return parseBody(await res.text());
  }

  private async notify(method: string): Promise<void> {
    await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method }),
    });
  }
}

/** Streamable HTTP may answer as SSE; unwrap the `data:` payload. */
export function parseBody(text: string): JsonRpcResponse {
  const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
  const candidate = dataLine ? dataLine.slice(5).trim() : text;
  try {
    return JSON.parse(candidate) as JsonRpcResponse;
  } catch {
    return { jsonrpc: '2.0', error: { code: -32700, message: `unparseable response: ${text.slice(0, 200)}` } };
  }
}

function extractText(result: Record<string, unknown>): string {
  const content = result.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (isRecord(c) && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
