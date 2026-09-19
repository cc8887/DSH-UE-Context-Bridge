/**
 * Resolve machine-specific roots for the verification scripts.
 *
 * The committed defaults are placeholders, since the real values are per
 * machine and would leak a username if hardcoded. Set the matching
 * environment variables to run a script against your own layout:
 *
 *   UE_BRIDGE_REPO    this clone
 *   UE_ENGINE_ROOT    an Unreal Engine source tree or install
 *   UE_PROJECT_ROOT   a project to exercise (defaults to <repo>/ue-project)
 */

export const REPO_ROOT =
  process.env.UE_BRIDGE_REPO ?? '/path/to/dsh-ue-context-bridge';

export const ENGINE_ROOT =
  process.env.UE_ENGINE_ROOT ?? '/path/to/UnrealEngine';

export const PROJECT_ROOT =
  process.env.UE_PROJECT_ROOT ?? `${REPO_ROOT}/ue-project`;

/**
 * Fail with a readable message instead of a confusing ENOENT deep in a script.
 */
export function requireRealPath(name: string, value: string): string {
  if (value.startsWith('/path/to/') || value === '<REPO>' || value === '<ENGINE>') {
    console.error(
      `${name} is a placeholder ("${value}"). Set the matching environment variable before running this script.`,
    );
    process.exit(2);
  }
  return value;
}
