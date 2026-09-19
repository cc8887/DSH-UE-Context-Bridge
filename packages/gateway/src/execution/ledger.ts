/**
 * execution.ts — invocation ledger and state machine (plan section 8).
 *
 * v0.1 serializes all operations against one editor. The lock coordinates only
 * operations issued through this gateway; it does not block human editing or
 * other external clients.
 */

import type { ExecutionState } from '@ue-bridge/contracts/model-tools';

export type RunPhase =
  | 'RECEIVED'
  | 'VALIDATED'
  | 'AWAITING_APPROVAL'
  | 'QUEUED'
  | 'DISPATCHED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'UNKNOWN'
  | 'CANCELLED_BEFORE_DISPATCH';

export interface LedgerRecord {
  run_id: string;
  host_call_id: string;
  session_id: string;
  project_id: string;
  editor_epoch: string;
  adapter_version: string;
  request_digest: string;
  approval_digest?: string;
  effect_class: string;
  phase: RunPhase;
  last_transport_state?: string;
  last_error?: string;
  created_at: string;
  dispatched_at?: string;
  settled_at?: string;
  result_id?: string;
}

let seq = 0;

export class InvocationLedger {
  private records = new Map<string, LedgerRecord>();
  private byHostCall = new Map<string, string>();
  private locked = false;

  /**
   * Transport-level retry with the same host_call_id returns the same record.
   * A model-initiated repeat is a new intent and must not be swallowed just
   * because the code is identical.
   */
  findByHostCallId(hostCallId: string): LedgerRecord | undefined {
    const runId = this.byHostCall.get(hostCallId);
    return runId ? this.records.get(runId) : undefined;
  }

  create(init: Omit<LedgerRecord, 'run_id' | 'phase' | 'created_at'>): LedgerRecord {
    seq += 1;
    const record: LedgerRecord = {
      ...init,
      run_id: `run-${init.session_id}-${seq}`,
      phase: 'RECEIVED',
      created_at: new Date().toISOString(),
    };
    this.records.set(record.run_id, record);
    this.byHostCall.set(record.host_call_id, record.run_id);
    return record;
  }

  update(runId: string, patch: Partial<LedgerRecord>): LedgerRecord | undefined {
    const current = this.records.get(runId);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.records.set(runId, next);
    return next;
  }

  get(runId: string): LedgerRecord | undefined {
    return this.records.get(runId);
  }

  tryAcquire(): boolean {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  /**
   * The write mutex is not released merely because a client timed out; an
   * unconfirmed termination keeps the lock.
   */
  release(): void {
    this.locked = false;
  }

  get busy(): boolean {
    return this.locked;
  }
}

export function phaseToExecutionState(phase: RunPhase): ExecutionState {
  switch (phase) {
    case 'SUCCEEDED':
      return 'succeeded';
    case 'FAILED':
      return 'failed';
    default:
      return 'unknown';
  }
}
