/**
 * Byte budgets and result-boundary rules (plan section 11.1).
 *
 * These are starting parameters to be measured, NOT DSH or UE official limits.
 */

export const BUDGETS = {
  /** Default summary candidates per find. */
  SEARCH_CANDIDATES: 5,
  SEARCH_SUMMARY_BYTES: 4 * 1024,
  /** One full tool definition response. */
  FULL_DEFINITION_BYTES: 16 * 1024,
  /** Ordinary call result. */
  RESULT_BYTES: 12 * 1024,
  /** Failure samples kept, with the total failure count always preserved. */
  FAILURE_SAMPLES: 10,
  /** One in-flight execution per editor. */
  IN_FLIGHT_EXECUTIONS: 1,
} as const;

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Invariant 5 (plan section 5.2): a large result is collapsed to a small
 * canonical value, not merely rendered shorter. Truncation is always reported.
 *
 * The envelope deliberately does not embed a partial JSON string: re-encoding a
 * fragment escapes every quote and inflates the payload back past the budget.
 * Full content is retrieved through the artifact store with `result_id` +
 * cursor, which is real pagination rather than a text tail cut.
 */
export function boundJson(
  value: unknown,
  maxBytes: number,
  summary?: unknown,
): { value: unknown; truncated: boolean; actualBytes: number } {
  const raw = JSON.stringify(value ?? null);
  const actualBytes = utf8ByteLength(raw);
  if (actualBytes <= maxBytes) {
    return { value, truncated: false, actualBytes };
  }

  const envelope: Record<string, unknown> = {
    truncated: true,
    note: 'OUTPUT_LIMIT_EXCEEDED',
    actual_bytes: actualBytes,
    byte_budget: maxBytes,
    hint: 'read the full value with result_id + cursor, or narrow the query',
  };
  if (summary !== undefined) {
    const boundedSummary = fitSummary(summary, 2048);
    if (boundedSummary !== undefined) envelope.summary = boundedSummary;
  }
  return { value: envelope, truncated: true, actualBytes };
}

/** Keep a caller-supplied summary only when it genuinely fits. */
function fitSummary(summary: unknown, maxBytes: number): unknown {
  const bytes = utf8ByteLength(JSON.stringify(summary ?? null));
  if (bytes <= maxBytes) return summary;
  if (Array.isArray(summary)) {
    let count = summary.length;
    while (count > 0) {
      const head = summary.slice(0, count);
      if (utf8ByteLength(JSON.stringify(head)) <= maxBytes) {
        return { items: head, total: summary.length, returned: count };
      }
      count = Math.floor(count / 2);
    }
  }
  return undefined;
}
