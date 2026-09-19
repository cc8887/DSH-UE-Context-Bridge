/**
 * Private gateway IPC contract (plan section 3.2).
 *
 * These RPCs are NOT model tools. Identity fields (session_id, project_id,
 * editor_epoch) are bound by the host plugin; the model never supplies them.
 */

import type { EffectClass, ErrorEnvelope } from './model-tools.ts';

export const IPC_PROTOCOL_VERSION = '0.1.0';

export type IpcMethod =
  | 'gateway.connect'
  | 'gateway.health'
  | 'catalog.search'
  | 'catalog.describe'
  | 'invocation.execute'
  | 'invocation.status'
  | 'artifact.read_page';

/** Host-bound identity. Never accepted from the model. */
export interface IpcIdentity {
  session_id: string;
  project_id: string;
  editor_epoch: string;
  host_call_id: string;
}

export interface IpcRequest<M extends IpcMethod = IpcMethod, P = unknown> {
  jsonrpc: '2.0';
  id: string;
  method: M;
  params: P;
  identity: IpcIdentity;
}

export interface IpcSuccess<T = unknown> {
  jsonrpc: '2.0';
  id: string;
  result: T;
}

export interface IpcFailure {
  jsonrpc: '2.0';
  id: string;
  error: ErrorEnvelope & { data?: unknown };
}

export type IpcResponse<T = unknown> = IpcSuccess<T> | IpcFailure;

export interface ConnectParams {
  /** Read from the user-confirmed generated config; never a hardcoded port. */
  mcp_entry: { transport: 'http' | 'stdio'; url?: string; command?: string; args?: string[] };
}

export interface ConnectResult {
  protocol: string;
  capabilities: string[];
  engine_build: string;
  editor_epoch: string;
}

export interface HealthResult {
  online: boolean;
  /** A cached catalog alone is not proof the editor is online (plan section 4). */
  verified_by_realtime_probe: boolean;
  editor_epoch?: string;
}

export interface CatalogSearchParams {
  query?: string;
  tool_ids?: string[];
  detail: 'summary' | 'schema';
  limit?: number;
  cursor?: string;
}

export interface CatalogDescribeParams {
  tool_id: string;
  schema_revision?: string;
}

export interface InvocationExecuteParams {
  tool_id: string;
  schema_revision: string;
  arguments: Record<string, unknown>;
  effect_class: EffectClass;
  approval_digest?: string;
}

export interface InvocationStatusParams {
  run_id: string;
}

export interface ArtifactReadPageParams {
  result_id: string;
  cursor?: string;
}

/** Framed JSON-lines: one JSON object per line, protocol on a dedicated stdio. */
export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function decodeFrame(line: string): unknown {
  return JSON.parse(line);
}
