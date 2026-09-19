/**
 * main.ts — gateway process entry.
 *
 * Protocol on stdin/stdout as JSON-lines; logs on stderr.
 * This process is a UE MCP client only. It does not expose an MCP server to
 * the model in v0.1.
 */

import { IPC_PROTOCOL_VERSION, encodeFrame, type IpcRequest, type IpcResponse } from '@ue-bridge/contracts/ipc';
import { retryPolicyForCode, type ErrorEnvelope, type UeErrorCode } from '@ue-bridge/contracts/model-tools';
import { BUDGETS, boundJson } from '@ue-bridge/contracts/results';
import { InvocationLedger, phaseToExecutionState } from './execution/ledger.ts';
import { schemaRevisionOf, searchCatalog, type CatalogSnapshot, type ToolRecord } from './catalog/catalog.ts';
import { UeMcpClient, type McpToolEntry } from './upstream-mcp/client.ts';

const ledger = new InvocationLedger();
const upstream = new UeMcpClient();

/** Empty until connect() builds it from a real tools/list response. */
let snapshot: CatalogSnapshot = {
  engineBuild: 'unknown',
  projectFingerprint: 'unknown',
  editorEpoch: 'unknown',
  adapterVersion: '0.1.0',
  coverageComplete: false,
  tools: [],
  builtAt: new Date().toISOString(),
};

/**
 * Build the complete per-tool index from one real tools/list.
 *
 * With bEnableToolSearch=False the editor returns every tool directly, so the
 * index needs no meta-tool traversal and no guessing.
 */
async function rebuildSnapshot(endpoint: string): Promise<void> {
  const tools = await upstream.listTools();
  snapshot = {
    engineBuild: 'unknown',
    projectFingerprint: 'unknown',
    editorEpoch: new Date().toISOString(),
    adapterVersion: '0.1.0',
    coverageComplete: true,
    builtAt: new Date().toISOString(),
    tools: tools.map((t) => toRecord(t)),
  };
  process.stderr.write(`gateway: indexed ${tools.length} tools from ${endpoint}\n`);
}

function toRecord(entry: McpToolEntry): ToolRecord {
  const inputSchema = entry.inputSchema;
  return {
    id: entry.name,
    toolsetName: '',
    toolName: entry.name,
    description: entry.description ?? '',
    inputSchema,
    ...(entry.outputSchema ? { outputSchema: entry.outputSchema } : {}),
    schemaRevision: schemaRevisionOf({
      inputSchema,
      description: entry.description ?? '',
      adapterVersion: '0.1.0',
    }),
    projectFingerprint: 'unknown',
    engineBuild: 'unknown',
    effectClass: 'unknown',
    effectEvidence: 'unverified',
  };
}

function error(code: UeErrorCode, message: string, details?: Record<string, unknown>): ErrorEnvelope {
  return { code, message, retry: retryPolicyForCode(code), ...(details ? { details } : {}) };
}

async function handle(req: IpcRequest): Promise<IpcResponse> {
  const { method, params } = req;
  const p = (params ?? {}) as Record<string, unknown>;

  switch (method) {
    case 'gateway.health': {
      // A cached catalog is never proof the editor is online.
      const health = await upstream.health();
      return { jsonrpc: '2.0', id: req.id, result: health };
    }

    case 'gateway.connect': {
      if (!p.mcp_entry) {
        return { jsonrpc: '2.0', id: req.id, error: error('EDITOR_UNAVAILABLE', 'mcp_entry is required; read it from the generated config') };
      }
      const result = await upstream.connect({ mcp_entry: p.mcp_entry } as never);
      // Build the real per-tool index from the complete listing.
      await rebuildSnapshot((p.mcp_entry as { url?: string }).url ?? '');
      return { jsonrpc: '2.0', id: req.id, result: { ...result, tools: snapshot.tools.length } };
    }

    case 'catalog.search': {
      const hits = searchCatalog(
        snapshot,
        p.query as string | undefined,
        p.tool_ids as string[] | undefined,
        (p.limit as number) ?? BUDGETS.SEARCH_CANDIDATES,
      );
      const detail = (p.detail as 'summary' | 'schema') ?? 'summary';
      let payload: unknown;
      if (detail === 'schema' && hits.length === 1) {
        const record = hits[0]!.record;
        payload = { mode: 'deferred', complete: true, definition: toDefinition(record) };
      } else {
        payload = {
          mode: 'deferred',
          coverage: snapshot.coverageComplete ? 'complete' : 'partial',
          hits: hits.map((h) => ({
            id: h.record.id,
            toolsetName: h.record.toolsetName,
            toolName: h.record.toolName,
            description: h.record.description.slice(0, 240),
            schemaRevision: h.record.schemaRevision,
            effectClass: h.record.effectClass,
            truncated: h.record.description.length > 240,
          })),
          ...(snapshot.coverageComplete ? {} : { widenHint: 'catalog coverage is partial; widen or rephrase the query' }),
        };
      }
      const bounded = boundJson(payload, BUDGETS.FULL_DEFINITION_BYTES);
      return { jsonrpc: '2.0', id: req.id, result: bounded.value };
    }

    case 'catalog.describe': {
      const toolId = p.tool_id as string;
      const record = snapshot.tools.find((t) => t.id === toolId);
      if (!record) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: error('SCHEMA_STALE', `tool "${toolId}" is not in the current catalog`, { coverage: snapshot.coverageComplete ? 'complete' : 'partial' }),
        };
      }
      return { jsonrpc: '2.0', id: req.id, result: toDefinition(record) };
    }

    case 'invocation.execute': {
      if (ledger.busy) {
        return { jsonrpc: '2.0', id: req.id, error: error('EDITOR_BUSY', 'another execution is in flight for this editor') };
      }
      const existing = ledger.findByHostCallId(req.identity.host_call_id);
      if (existing) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: {
            run_id: existing.run_id,
            execution: phaseToExecutionState(existing.phase),
            verification: 'not_run',
            persistence: 'not_checked',
            truncated: false,
          },
        };
      }
      if (!ledger.tryAcquire()) {
        return { jsonrpc: '2.0', id: req.id, error: error('EDITOR_BUSY', 'could not acquire the editor execution lock') };
      }
      const record = ledger.create({
        host_call_id: req.identity.host_call_id,
        session_id: req.identity.session_id,
        project_id: req.identity.project_id,
        editor_epoch: req.identity.editor_epoch,
        adapter_version: snapshot.adapterVersion,
        request_digest: JSON.stringify(p),
        effect_class: String(p.effect_class ?? 'unknown'),
      });
      try {
        ledger.update(record.run_id, { phase: 'QUEUED' });
        ledger.update(record.run_id, { phase: 'DISPATCHED', dispatched_at: new Date().toISOString() });
        const toolId = String(p.tool_id ?? '');
        const raw = await upstream.callTool({
          name: toolId,
          args: (p.arguments as Record<string, unknown>) ?? {},
        });
        ledger.update(record.run_id, { phase: 'SUCCEEDED', settled_at: new Date().toISOString() });
        const bounded = boundJson(raw, BUDGETS.RESULT_BYTES);
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: {
            run_id: record.run_id,
            execution: 'succeeded',
            verification: 'not_run',
            persistence: 'not_checked',
            truncated: bounded.truncated,
            value: bounded.value,
          },
        };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        ledger.update(record.run_id, { phase: 'FAILED', settled_at: new Date().toISOString(), last_error: message });
        return { jsonrpc: '2.0', id: req.id, error: error('REMOTE_OUTCOME_UNKNOWN', message) };
      } finally {
        ledger.release();
      }
    }

    case 'invocation.status': {
      const record = ledger.get(p.run_id as string);
      if (!record) {
        return { jsonrpc: '2.0', id: req.id, error: error('RESULT_EXPIRED', `unknown run_id "${String(p.run_id)}"`) };
      }
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          run_id: record.run_id,
          execution: phaseToExecutionState(record.phase),
          verification: 'not_run',
          persistence: 'not_checked',
          phase: record.phase,
          truncated: false,
        },
      };
    }

    case 'artifact.read_page': {
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: error('RESULT_EXPIRED', 'artifact store is not implemented in v0.1'),
      };
    }

    default:
      return { jsonrpc: '2.0', id: req.id, error: error('INVALID_ARGUMENTS', `unknown rpc "${method}"`) };
  }
}

function toDefinition(record: ToolRecord) {
  const bounded = boundJson(
    {
      id: record.id,
      toolsetName: record.toolsetName,
      toolName: record.toolName,
      description: record.description,
      inputSchema: record.inputSchema,
      ...(record.outputSchema ? { outputSchema: record.outputSchema } : {}),
      schemaRevision: record.schemaRevision,
      effectClass: record.effectClass,
      complete: true,
    },
    BUDGETS.FULL_DEFINITION_BYTES,
  );
  // A truncated schema is never presented as executable.
  if (bounded.truncated) {
    return { id: record.id, complete: false, code: 'SCHEMA_TOO_LARGE', schemaRevision: record.schemaRevision };
  }
  return bounded.value;
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) {
      void (async () => {
        try {
          const req = JSON.parse(line) as IpcRequest;
          const res = await handle(req);
          process.stdout.write(encodeFrame(res));
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          process.stderr.write(`gateway: ${message}\n`);
        }
      })();
    }
    index = buffer.indexOf('\n');
  }
});

process.stderr.write(`gateway: ready (protocol ${IPC_PROTOCOL_VERSION})\n`);
