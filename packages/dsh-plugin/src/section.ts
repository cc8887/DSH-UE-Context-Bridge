/**
 * Static prompt sections (plan section 5.2 invariants 2 and 3).
 *
 * These strings are frozen: they carry no runtime state, no catalog hash, no
 * project name, and no tool directory. Keeping them static is what preserves
 * the reusable prompt prefix.
 */

import type { ModeName } from '@ue-bridge/contracts/model-tools';

export const SECTION_ORDER_UE_MODE = 6100;

const DEFERRED_SECTION = `## Unreal Engine access (deferred mode)

You reach the Unreal Editor through exactly two tools:

- \`ue_find\`: search the local tool catalog and return summaries or one full definition.
- \`ue_call\`: invoke a discovered tool, page through a large result, or query a run.

Workflow: call \`ue_find\` with a natural-language query, pick a \`tool_id\` from the
real results, request \`detail: "schema"\` to read its parameters, then call \`ue_call\`
with \`action: "invoke"\`, the \`tool_id\` and the exact \`schema_revision\` you were given.

Rules:
- Never guess a \`tool_id\` or \`schema_revision\`; always take them from \`ue_find\` output.
- \`ue_call\` results are bounded. When \`truncated\` is true, continue with
  \`action: "read_result"\` and the returned cursor.
- \`execution\`, \`verification\` and \`persistence\` are separate facts. A successful
  execution alone does not mean the change was saved or accepted.
- If \`coverage\` is \`partial\`, the catalog is incomplete: a missing tool is not
  proven absent. Widen or rephrase the query.
- Errors carry a \`retry\` field. Respect \`needs_state_check\`: re-read the actual
  editor state instead of resending the same operation.`;

const PYTHON_SECTION = `## Unreal Engine access (python mode)

You reach the Unreal Editor through exactly one tool: \`ue_python_execute\`, which
runs Python inside the editor process.

The \`uex\` helper is available inside those scripts:

- \`uex.find(query, limit=5)\` - search the local tool catalog.
- \`uex.describe(tool_id)\` - read one tool's parameters.
- \`uex.call(tool_id, arguments)\` - invoke a discovered tool.
- \`uex.emit(value, max_items=20)\` - emit a bounded structured result.
- \`uex.read_result(result_id, cursor=None)\` - read one page of a full result.
- \`uex.run_status(run_id)\` - query an editor-side run record.

Rules:
- Keep loops, filtering and batching inside the editor; return only what is needed.
- Emit results with \`uex.emit\`. stdout and stderr are independently bounded.
- Each script runs with fresh globals. Do not rely on variables from a previous run.
- \`description\` is for human review only; it does not grant or limit permissions.
- An execution success is not a save confirmation and not an acceptance verdict.`;

export function staticSectionFor(mode: ModeName): string {
  return mode === 'deferred' ? DEFERRED_SECTION : PYTHON_SECTION;
}

export function sectionNameFor(mode: ModeName): string {
  return `ue-bridge:mode:${mode}`;
}
