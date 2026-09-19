/**
 * Model-facing tool contracts (plan section 6.1, 7.1).
 *
 * These shapes are frozen at registration time. Nothing here may vary with
 * catalog contents, project selection, or engine build — that is invariant 3
 * and invariant 2 in plan section 5.2.
 */

/** The only two model-visible UE entry points in Deferred mode. */
export const UE_FIND = 'ue_find';
export const UE_CALL = 'ue_call';

/** The single model-visible UE entry point in Python-only mode. */
export const UE_PYTHON_EXECUTE = 'ue_python_execute';

/**
 * Editor lifecycle entry points.
 *
 * Deliberately three, not one per operation: the model states intent (get the
 * editor usable) and dsh decides whether that means build, launch, or both,
 * returning what it did and any failure it hit.
 */
export const UE_EDITOR_STATUS = 'ue_editor_status';
export const UE_EDITOR_START = 'ue_editor_start';
export const UE_EDITOR_STOP = 'ue_editor_stop';
/**
 * Build-environment check. Separate from status: status is about the editor
 * process, this is about whether the machine can build at all. Keeping them
 * apart means a toolchain problem is not buried in process state.
 */
export const UE_ENV_CHECK = 'ue_env_check';

export type ModeName = 'deferred' | 'python';

export const DEFERRED_TOOL_NAMES: readonly string[] = [
  UE_FIND,
  UE_CALL,
  UE_EDITOR_STATUS,
  UE_EDITOR_START,
  UE_EDITOR_STOP,
  UE_ENV_CHECK,
];
export const PYTHON_TOOL_NAMES: readonly string[] = [
  UE_PYTHON_EXECUTE,
  UE_EDITOR_STATUS,
  UE_EDITOR_START,
  UE_EDITOR_STOP,
  UE_ENV_CHECK,
];

export type FindDetail = 'summary' | 'schema';

export interface FindRequest {
  query?: string;
  tool_ids?: string[];
  detail: FindDetail;
  limit?: number;
  cursor?: string;
}

export type CallRequest =
  | {
      action: 'invoke';
      tool_id: string;
      schema_revision: string;
      arguments: Record<string, unknown>;
    }
  | {
      action: 'read_result';
      result_id: string;
      cursor?: string;
    }
  | { action: 'run_status'; run_id: string };

/** Fixed small enum; never expanded to enumerate UE operation names. */
export const CALL_ACTIONS: readonly string[] = ['invoke', 'read_result', 'run_status'];

export interface PythonExecuteRequest {
  code: string;
  description: string;
}

/**
 * Search hit shape returned by ue_find. `coverage: partial` must be surfaced
 * whenever the local index is incomplete, so an unindexed tool is never
 * reported as nonexistent (plan section 6.4).
 */
export interface ToolSummary {
  id: string;
  toolsetName: string;
  toolName: string;
  description: string;
  schemaRevision: string;
  effectClass: EffectClass;
  truncated: boolean;
}

export interface ToolDefinitionResult {
  id: string;
  toolsetName: string;
  toolName: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  schemaRevision: string;
  effectClass: EffectClass;
  complete: boolean;
}

export interface FindResponse {
  mode: ModeName;
  coverage: 'complete' | 'partial';
  hits: ToolSummary[];
  nextCursor?: string;
  /** Set when no hit was found, so the model can widen rather than conclude absence. */
  widenHint?: string;
}

export type EffectClass = 'verified_read' | 'write' | 'privileged' | 'unknown';

/** Plan section 8.3: execution, persistence, and verification are distinct facts. */
export type ExecutionState = 'succeeded' | 'failed' | 'unknown';
export type VerificationState = 'passed' | 'failed' | 'not_run';
export type PersistenceState = 'saved' | 'not_saved' | 'not_checked';

export interface CallResponse {
  run_id: string;
  execution: ExecutionState;
  verification: VerificationState;
  persistence: PersistenceState;
  result_id?: string;
  truncated: boolean;
  /** Bounded canonical value; never the raw UE payload. */
  value?: unknown;
  nextCursor?: string;
  errors?: ErrorEnvelope[];
}

export interface PythonExecuteResponse {
  run_id: string;
  execution: ExecutionState;
  /** stdout/stderr are independently bounded by the gateway. */
  stdout: string;
  stderr: string;
  result_id?: string;
  truncated: boolean;
  errors?: ErrorEnvelope[];
}

/** Plan section 11.2. */
export type UeErrorCode =
  | 'EDITOR_UNAVAILABLE'
  | 'EDITOR_BUSY'
  | 'SCHEMA_STALE'
  | 'UNSUPPORTED_SCHEMA'
  | 'SCHEMA_TOO_LARGE'
  | 'INVALID_ARGUMENTS'
  | 'PYTHON_BINDING_UNAVAILABLE'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_DENIED'
  | 'PROJECT_CHANGED'
  | 'PRECONDITION_CHANGED'
  | 'RESULT_EXPIRED'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'REMOTE_OUTCOME_UNKNOWN'
  | 'VERIFICATION_FAILED';

/** Plan section 11.2: every error carries an explicit retry policy. */
export type RetryPolicy =
  | 'safe_to_retry'
  | 'needs_rediscovery'
  | 'needs_state_check'
  | 'manual_only';

export interface ErrorEnvelope {
  code: UeErrorCode;
  message: string;
  retry: RetryPolicy;
  details?: Record<string, unknown>;
}

/**
 * Writes that land in an unknown state default to needs_state_check and must
 * never be auto-replayed (plan section 11.2).
 */
export function retryPolicyForCode(code: UeErrorCode): RetryPolicy {
  switch (code) {
    case 'SCHEMA_STALE':
    case 'UNSUPPORTED_SCHEMA':
    case 'SCHEMA_TOO_LARGE':
      return 'needs_rediscovery';
    case 'EDITOR_UNAVAILABLE':
    case 'EDITOR_BUSY':
    case 'PYTHON_BINDING_UNAVAILABLE':
      return 'safe_to_retry';
    case 'REMOTE_OUTCOME_UNKNOWN':
    case 'PRECONDITION_CHANGED':
    case 'PROJECT_CHANGED':
    case 'RESULT_EXPIRED':
      return 'needs_state_check';
    case 'APPROVAL_REQUIRED':
    case 'APPROVAL_DENIED':
    case 'VERIFICATION_FAILED':
    case 'INVALID_ARGUMENTS':
    case 'OUTPUT_LIMIT_EXCEEDED':
      return 'manual_only';
    default:
      return 'manual_only';
  }
}
