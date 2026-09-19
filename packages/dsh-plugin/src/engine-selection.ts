/**
 * engine-selection.ts — remember which engine each project builds against.
 *
 * Which engine a project uses is a human decision, not something to infer.
 * Several engines can be installed side by side (this machine has thirteen),
 * and picking the wrong one surfaces minutes later as a confusing build error
 * rather than as a clear "wrong engine".
 *
 * So the choice is made once, by the user, per project, and persisted. dsh
 * never re-asks and never silently switches: a recorded selection is replaced
 * only when the user asks, or when it stops pointing at a real engine.
 *
 * Keyed by project root because the decision is per project. A second editor
 * for a second project gets its own entry and its own turn to be decided,
 * which is what makes "decide them one at a time" possible.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface EngineSelection {
  /** UE's identifier, when the chosen engine was a known install. */
  identifier?: string;
  engineRoot: string;
  /** ISO timestamp: when the user decided. */
  decidedAt: string;
  /** Version captured at decision time, so the record stays readable later. */
  version?: string;
}

interface SelectionFile {
  version: 1;
  projects: Record<string, EngineSelection>;
}

/** Where selections live by default: alongside the rest of dsh's state. */
export function defaultSelectionPath(): string {
  const base = process.env.USERPROFILE ?? homedir();
  return join(base, '.dsh', 'ue-bridge', 'engine-selection.json');
}

/** Matches the normalization used when resolving, so keys line up. */
export function selectionKeyFor(projectRoot: string): string {
  let key = resolve(projectRoot).replace(/\\/g, '/');
  while (key.length > 2 && key.endsWith('/')) key = key.slice(0, -1);
  return key.toLowerCase();
}

export class EngineSelectionStore {
  private readonly path: string;
  private cache: SelectionFile | null = null;

  constructor(path: string = defaultSelectionPath()) {
    this.path = path;
  }

  get file(): string {
    return this.path;
  }

  private read(): SelectionFile {
    if (this.cache) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = { version: 1, projects: {} };
      return this.cache;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as SelectionFile;
      this.cache =
        parsed?.version === 1 && parsed.projects ? parsed : { version: 1, projects: {} };
    } catch {
      // Corrupt or unreadable: start clean rather than fail every lookup.
      this.cache = { version: 1, projects: {} };
    }
    return this.cache;
  }

  /** The recorded choice for one project, if any. */
  get(projectRoot: string): EngineSelection | undefined {
    return this.read().projects[selectionKeyFor(projectRoot)];
  }

  /** Record (or replace) the choice for one project. */
  set(projectRoot: string, selection: EngineSelection): void {
    const file = this.read();
    file.projects[selectionKeyFor(projectRoot)] = selection;
    this.persist(file);
  }

  /** Forget the choice, so the next check asks again. */
  clear(projectRoot: string): void {
    const file = this.read();
    delete file.projects[selectionKeyFor(projectRoot)];
    this.persist(file);
  }

  /** Every recorded choice, keyed by normalized project root. */
  all(): Record<string, EngineSelection> {
    return { ...this.read().projects };
  }

  /** How many projects have been decided. */
  get decidedCount(): number {
    return Object.keys(this.read().projects).length;
  }

  private persist(file: SelectionFile): void {
    this.cache = file;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(file, null, 2), 'utf8');
    } catch {
      // Persistence is best-effort; an unwritable file must not break resolution.
    }
  }
}
