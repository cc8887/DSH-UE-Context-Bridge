/**
 * catalog.ts — local tool catalog (plan section 6.2, 6.3).
 *
 * The full per-tool index is built from toolset descriptions, never guessed
 * from a top-level tools/list that only exposes meta-tools.
 */

import type { EffectClass } from '@ue-bridge/contracts/model-tools';

export interface ToolRecord {
  id: string;
  toolsetName: string;
  toolName: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  schemaRevision: string;
  projectFingerprint: string;
  engineBuild: string;
  effectClass: EffectClass;
  effectEvidence: 'adapter_rule' | 'manual_review' | 'unverified';
  pythonBinding?: { kind: string; verifiedFixture: string };
}

export interface CatalogSnapshot {
  engineBuild: string;
  projectFingerprint: string;
  editorEpoch: string;
  adapterVersion: string;
  /** False when the index covers only part of the toolsets. */
  coverageComplete: boolean;
  tools: ToolRecord[];
  builtAt: string;
}

/** Normalized schema hashing; never rewrites a registered model-facing schema. */
export function schemaRevisionOf(input: {
  inputSchema: unknown;
  description: string;
  adapterVersion: string;
}): string {
  const canonical = stableStringify({
    schema: input.inputSchema,
    description: input.description,
    adapter: input.adapterVersion,
  });
  return `rev:${fnv1a(canonical)}`;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9一-龥]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

export interface SearchHit {
  record: ToolRecord;
  score: number;
}

/**
 * Priority: exact tool id > exact method/param name > toolset name > keyword.
 * No LLM query rewrite per search.
 */
export function searchCatalog(
  snapshot: CatalogSnapshot,
  query: string | undefined,
  toolIds: string[] | undefined,
  limit: number,
): SearchHit[] {
  if (toolIds && toolIds.length > 0) {
    const wanted = new Set(toolIds);
    return snapshot.tools
      .filter((t) => wanted.has(t.id))
      .slice(0, limit)
      .map((record) => ({ record, score: 100 }));
  }
  if (!query) return [];

  const terms = tokenize(query);
  const hits: SearchHit[] = [];
  for (const record of snapshot.tools) {
    const idLower = record.id.toLowerCase();
    const toolLower = record.toolName.toLowerCase();
    const setLower = record.toolsetName.toLowerCase();
    const descLower = record.description.toLowerCase();

    let score = 0;
    if (idLower === query.toLowerCase() || toolLower === query.toLowerCase()) score += 100;
    for (const term of terms) {
      if (idLower.includes(term)) score += 12;
      if (toolLower.includes(term)) score += 10;
      if (setLower.includes(term)) score += 6;
      if (descLower.includes(term)) score += 3;
      for (const key of schemaKeys(record.inputSchema)) {
        if (key.toLowerCase().includes(term)) score += 2;
      }
    }
    if (score > 0) hits.push({ record, score });
  }
  hits.sort((a, b) => (b.score - a.score) || (a.record.id < b.record.id ? -1 : 1));
  return hits.slice(0, limit);
}

function schemaKeys(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const props = (schema as Record<string, unknown>).properties;
  if (!props || typeof props !== 'object') return [];
  return Object.keys(props as Record<string, unknown>);
}
