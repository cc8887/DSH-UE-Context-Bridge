/**
 * One shared implementation of "where is the Unreal engine, and which project
 * do I drive", for every script in scripts/.
 *
 * Why this exists: four scripts had grown their own copy of this logic. The
 * copies had already drifted apart — the crash scripts probe for
 * Engine/Binaries/Win64 while the build script probes for Build.bat — and all
 * of them shared one blind spot: they enumerated only cwd, ~/Github and
 * homedir, so an engine living on a different drive than the home directory
 * was invisible and the script silently SKIPped. That is precisely the kind of
 * failure that pushes an author toward hard-coding a path, which is the thing
 * this module exists to make unnecessary.
 *
 * So resolution is: env var wins, then a walk from cwd up to the filesystem
 * root, then the conventional dev-drive roots. The upward walk is the part
 * that finds G:/Github/... from a C: home. Unresolved means the caller SKIPs
 * with exit 0, which keeps every script safe to run in CI on a machine with
 * no engine at all.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

export const ENV_ENGINE_ROOT = 'DSH_UE_ENGINE_ROOT';
export const ENV_PROJECT_ROOT = 'DSH_UE_PROJECT_ROOT';

/**
 * What must exist for a directory to count as an engine root.
 *
 * The two callers want different things: driving a crash needs the editor
 * binary, driving a build needs UBT. Collapsing them into one test would
 * break whichever script needed the other one.
 */
export const ENGINE_PREDICATES = {
  /** A built editor exists, so the editor can be launched. */
  editor: (root) => existsSync(join(root, 'Engine', 'Binaries', 'Win64')),
  /** UBT is runnable, so a build can be driven. */
  build: (root) => existsSync(join(root, 'Engine', 'Build', 'BatchFiles', 'Build.bat')),
  /** Either: enough to answer "an engine lives here". */
  any: (root) => ENGINE_PREDICATES.editor(root) || ENGINE_PREDICATES.build(root),
};

/**
 * Parent directories worth enumerating: every ancestor of cwd up to the
 * filesystem root, plus the places people conventionally keep source.
 */
export function* discoveryRoots() {
  const seen = new Set();
  const push = (dir) => {
    const norm = resolve(dir);
    if (seen.has(norm)) return;
    seen.add(norm);
    return norm;
  };

  let dir = process.cwd();
  for (;;) {
    const norm = push(dir);
    if (norm) yield norm;
    const parent = dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }

  for (const extra of [join(homedir(), 'Github'), homedir()]) {
    const norm = push(extra);
    if (norm) yield norm;
  }
}

/** Every directory that could be an engine root, in preference order. */
export function engineCandidates() {
  const candidates = [];
  const env = process.env[ENV_ENGINE_ROOT];
  if (env) candidates.push(env);
  for (const parent of discoveryRoots()) {
    if (!existsSync(parent)) continue;
    candidates.push(parent);
    try {
      for (const entry of readdirSync(parent)) candidates.push(join(parent, entry));
    } catch {
      /* unreadable parent: skip it rather than fail the whole discovery */
    }
  }
  return candidates;
}

/**
 * Find the engine root.
 *
 * `predicate` decides what counts; see ENGINE_PREDICATES. Env var wins when
 * set, but it still has to satisfy the predicate, so a stale DSH_UE_ENGINE_ROOT
 * is reported rather than quietly accepted.
 */
export function discoverEngineRoot(predicate = ENGINE_PREDICATES.editor) {
  const test = typeof predicate === 'string' ? ENGINE_PREDICATES[predicate] : predicate;
  if (!test) throw new Error(`unknown engine predicate: ${String(predicate)}`);
  for (const root of engineCandidates()) {
    if (test(root)) return root;
  }
  return undefined;
}

/** Why discovery failed, for an honest SKIP message. */
export function describeEngineFailure(predicate = ENGINE_PREDICATES.editor) {
  const env = process.env[ENV_ENGINE_ROOT];
  const test = typeof predicate === 'string' ? ENGINE_PREDICATES[predicate] : predicate;
  if (env && !test(env)) {
    return `${ENV_ENGINE_ROOT} is set to ${env} but it is not a usable engine root`;
  }
  return `no engine found by probing; set ${ENV_ENGINE_ROOT}`;
}

/**
 * Find a project under the engine: env var, else the engine's own
 * Samples/Games, which is what a fresh source build always carries.
 */
export function discoverProjectRoot(engineRoot) {
  const env = process.env[ENV_PROJECT_ROOT];
  if (env && existsSync(env)) return env;
  const samples = join(engineRoot, 'Samples', 'Games');
  if (existsSync(samples)) {
    for (const name of readdirSync(samples)) {
      const dir = join(samples, name);
      if (existsSync(join(dir, `${name}.uproject`))) return dir;
    }
  }
  return undefined;
}

/**
 * Resolve engine + project + the derived paths every script ends up
 * recomputing. Returns undefined when either is missing, so callers can
 * `if (!env) { SKIP; exit 0 }` in one step.
 */
export function resolveUePaths({ require: requirement = 'editor' } = {}) {
  const engineRoot = discoverEngineRoot(requirement);
  if (!engineRoot) {
    return { ok: false, what: 'engine', reason: describeEngineFailure(requirement) };
  }
  const projectRoot = discoverProjectRoot(engineRoot);
  if (!projectRoot) {
    return {
      ok: false,
      what: 'project',
      reason: `no project found; set ${ENV_PROJECT_ROOT}`,
    };
  }
  const projectName = basename(projectRoot);
  return {
    ok: true,
    engineRoot,
    projectRoot,
    projectName,
    editor: join(engineRoot, 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe'),
    uproject: join(projectRoot, `${projectName}.uproject`),
    crashes: join(projectRoot, 'Saved', 'Crashes'),
    logs: join(projectRoot, 'Saved', 'Logs'),
  };
}
